/**
 * Records a live agent CLI session through a real PTY into a test fixture, bytes intact.
 *
 * Why a PTY and not `agy | tee`: a pipe is not a terminal, so the CLI renders its
 * non-interactive path — no alternate screen, no caret, no dialogs. The detector under
 * test only ever sees the PTY shape, so that is the only shape worth capturing.
 *
 * Nothing here strips escapes, folds CRs, or rewraps lines: the transcript is written
 * exactly as the terminal received it. See docs/reference/agent-pty-transcript-capture.md.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  formatFindings,
  redactTranscript,
  scanTranscriptForSecrets
} from './pty-transcript-secret-scan.mjs'

const REPO_ROOT = resolve(import.meta.dirname, '..', '..')
const FIXTURE_DIR = join(REPO_ROOT, 'src', 'main', 'runtime', '__fixtures__')
const STOP_KEY = 0x1d // Ctrl-], consumed by the recorder and never forwarded to the agent.
const NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const USAGE = `Capture a raw agent PTY transcript into src/main/runtime/__fixtures__/.

  node config/scripts/capture-agent-pty-transcript.mjs --name <fixture-name> [options] -- <command> [args...]
  node config/scripts/capture-agent-pty-transcript.mjs --scan <file...> [--redact]

Options
  --name <fixture-name>  Output fixture name, e.g. antigravity-ready-personal-non-gemini
  --out <path>           Write somewhere other than the fixture directory
  --cols <n> --rows <n>  Pin the PTY size (default: this terminal's size, else 120x40)
  --duration <seconds>   Stop unattended after N seconds
  --send "<ms>:<text>"   Type <text> into the PTY at <ms> (repeatable; \\r \\n \\t \\e escapes)
  --note "<text>"        Recorded in the <name>.meta.json sidecar
  --scan <file...>       Scan existing transcripts for identifiers/credentials and exit
  --redact               With --scan: rewrite each finding as a same-length placeholder

Press Ctrl-] to end a capture. That key is consumed here, so the agent keeps whatever
dialog it is showing — which is the only way to capture a dialog that owns the screen.`

function parseArgs(argv) {
  const options = { cols: null, rows: null, duration: null, scan: [], sends: [], redact: false }
  const command = []
  let cursor = 0
  let afterSeparator = false
  while (cursor < argv.length) {
    const arg = argv[cursor]
    if (afterSeparator) {
      command.push(arg)
      cursor += 1
      continue
    }
    if (arg === '--') {
      afterSeparator = true
    } else if (arg === '--redact') {
      options.redact = true
    } else if (arg === '--help' || arg === '-h') {
      options.help = true
    } else if (arg === '--scan') {
      while (cursor + 1 < argv.length && !argv[cursor + 1].startsWith('--')) {
        cursor += 1
        options.scan.push(argv[cursor])
      }
    } else if (arg === '--send') {
      cursor += 1
      options.sends.push(parseSend(argv[cursor]))
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      cursor += 1
      options[key] = argv[cursor]
    }
    cursor += 1
  }
  for (const key of ['cols', 'rows', 'duration']) {
    options[key] = options[key] == null ? null : Number(options[key])
  }
  return { options, command }
}

// String.fromCharCode, not a literal: the formatter rewrites an escape sequence into a raw
// control byte in source, which is unreadable and survives badly in diffs.
const ESC = String.fromCharCode(27)
const SEND_ESCAPES = { r: '\r', n: '\n', t: '\t', e: ESC, '\\': '\\' }

/** `"<ms>:<text>"` — a keystroke to deliver at a fixed offset, for an unattended dialog capture. */
function parseSend(value) {
  const separator = String(value ?? '').indexOf(':')
  if (separator === -1) {
    throw new Error(`--send expects "<ms>:<text>", got ${String(value)}`)
  }
  const atMs = Number(value.slice(0, separator))
  if (!Number.isFinite(atMs)) {
    throw new Error(
      `--send delay must be a number of milliseconds, got ${value.slice(0, separator)}`
    )
  }
  const text = value
    .slice(separator + 1)
    .replace(/\\(.)/g, (whole, code) => SEND_ESCAPES[code] ?? whole)
  return { atMs, text }
}

function runScan(files, redact) {
  let failed = false
  for (const file of files) {
    const path = resolve(file)
    const text = readFileSync(path, 'utf8')
    if (redact) {
      const { text: redacted, redacted: count } = redactTranscript(text)
      writeFileSync(path, redacted)
      console.log(`${file}: redacted ${count} span(s) in place, same length each.`)
      continue
    }
    const findings = scanTranscriptForSecrets(text)
    console.log(formatFindings(file, findings))
    failed ||= findings.length > 0
  }
  return failed ? 1 : 0
}

function resolveSpawn(command) {
  // node-pty cannot run a .cmd/.bat shim directly on Windows; those need cmd.exe.
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command[0])) {
    return { file: 'cmd.exe', args: ['/c', `"${command[0]}"`, ...command.slice(1)] }
  }
  return { file: command[0], args: command.slice(1) }
}

async function runCapture(options, command) {
  const name = options.name
  if (typeof name === 'string' && !NAME_RE.test(name)) {
    console.error(`--name must be lowercase kebab-case; got ${name}`)
    return 2
  }
  const outPath = options.out ? resolve(options.out) : join(FIXTURE_DIR, `${name}.txt`)
  mkdirSync(dirname(outPath), { recursive: true })

  const pty = await import('node-pty').catch((error) => {
    console.error(
      `node-pty failed to load. Build it for plain node first:
  node config/scripts/ensure-native-runtime.mjs --runtime=node
${String(error)}`
    )
    return null
  })
  if (pty === null) {
    return 2
  }

  const cols = options.cols ?? process.stdout.columns ?? 120
  const rows = options.rows ?? process.stdout.rows ?? 40
  const { file, args } = resolveSpawn(command)
  const term = pty.spawn(file, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: process.cwd(),
    env: { ...process.env, TERM: 'xterm-256color' },
    encoding: null
  })

  const sink = createWriteStream(outPath)
  let recording = true
  term.onData((chunk) => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    // Why recording stops before the kill: an agent repaints an idle frame on its way out, so
    // a transcript that keeps writing through shutdown ends on that frame instead of on the
    // state you stopped to capture. A mid-turn or dialog capture cannot survive that.
    if (recording) {
      sink.write(bytes)
    }
    process.stdout.write(bytes)
  })

  const wasRaw = process.stdin.isTTY === true && process.stdin.isRaw === true
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
  }
  process.stdin.resume()
  let stopping = false
  const stop = () => {
    if (stopping) {
      return
    }
    stopping = true
    recording = false
    try {
      term.kill()
    } catch {
      // The agent may have exited on its own; the transcript is already on disk.
    }
  }
  process.stdin.on('data', (chunk) => {
    if (chunk.includes(STOP_KEY)) {
      stop()
      return
    }
    term.write(chunk.toString('binary'))
  })
  // Why scripted input: a dialog capture has to be driven, and CI (or an agent) has no TTY to
  // type into. The keystrokes ride the same PTY a human's would, so the capture is unchanged.
  const sendTimers = options.sends.map((send) => setTimeout(() => term.write(send.text), send.atMs))
  const durationTimer = options.duration === null ? null : setTimeout(stop, options.duration * 1000)

  const exitCode = await new Promise((resolveExit) => {
    term.onExit(({ exitCode: code }) => resolveExit(code ?? 0))
  })
  for (const timer of sendTimers) {
    clearTimeout(timer)
  }
  if (durationTimer !== null) {
    clearTimeout(durationTimer)
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(wasRaw)
  }
  process.stdin.pause()
  await new Promise((done) => sink.end(done))

  writeMeta(outPath, { command, cols, rows, note: options.note ?? null, exitCode })
  const findings = scanTranscriptForSecrets(readFileSync(outPath, 'utf8'))
  console.log(`\nTranscript: ${outPath}`)
  console.log(formatFindings('scrub check', findings))
  if (findings.length > 0) {
    console.log(
      `Scrub with:
  node config/scripts/capture-agent-pty-transcript.mjs --scan ${outPath} --redact`
    )
  }
  return 0
}

function writeMeta(outPath, details) {
  const metaPath = outPath.replace(/\.txt$/, '.meta.json')
  writeFileSync(
    metaPath,
    `${JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        platform: process.platform,
        command: details.command,
        cols: details.cols,
        rows: details.rows,
        note: details.note,
        exitCode: details.exitCode
      },
      null,
      2
    )}\n`
  )
}

async function main() {
  const { options, command } = parseArgs(process.argv.slice(2))
  if (options.help === true) {
    console.log(USAGE)
    return 0
  }
  if (options.scan.length > 0) {
    return runScan(options.scan, options.redact)
  }
  if (command.length === 0 || (options.name === undefined && options.out === undefined)) {
    console.error(USAGE)
    return 2
  }
  return runCapture(options, command)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error) => {
      console.error(error)
      process.exitCode = 1
    }
  )
}

export { parseArgs, resolveSpawn }
