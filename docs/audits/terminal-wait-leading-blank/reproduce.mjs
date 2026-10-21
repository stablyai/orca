import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { build } from 'esbuild'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sourcePath = 'src/main/runtime/terminal-wait-tail-window.ts'
const absoluteSource = resolve(root, sourcePath)
const current = await readFile(absoluteSource, 'utf8')
const loop = '  while (lineEnd > 0) {'
const end = '    lineEnd = lineStart - 1\n  }\n  return 0\n}'
if (current.split(loop).length !== 2 || current.split(end).length !== 2) {
  throw new Error('Source changed; review the baseline transform.')
}
const baseline = current
  .replace(loop, '  for (;;) {')
  .replace(end, '    lineEnd = lineStart - 1\n  }\n}')
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const supportingSources = [
  'src/main/runtime/terminal-wait-detection.ts',
  'src/main/runtime/orca-runtime-terminal-projection.ts',
  'src/main/runtime/terminal-tail-read.ts',
  'src/main/runtime/terminal-tail-state.ts',
  'src/main/runtime/terminal-wait-tail-state.ts',
  'src/main/daemon/headless-emulator.ts',
  'src/main/runtime/terminal-wait-tail-window.test.ts'
]
const supportingSourceHashes = Object.fromEntries(
  await Promise.all(
    supportingSources.map(async (path) => [path, sha256(await readFile(resolve(root, path)))])
  )
)
const scratch = await mkdtemp(join(tmpdir(), 'orca-terminal-wait-blank-'))
const require = createRequire(import.meta.url)
let runnerId

try {
  const runnerPath = join(scratch, 'run-process.cjs')
  await build({
    entryPoints: [resolve(root, 'src/shared/child-process/run-process.ts')],
    outfile: runnerPath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  runnerId = require.resolve(runnerPath)
  const { runProcess } = require(runnerId)
  const entry = `
    import { startOfLastNonBlankLines } from './src/main/runtime/terminal-wait-tail-window';
    import { detectTerminalWaitBlockedReason, isKnownReadyPromptPreview } from './src/main/runtime/terminal-wait-detection';
    import { HeadlessEmulator } from './src/main/daemon/headless-emulator';
    import { projectTerminalVisibleLines, projectTerminalTailLines } from './src/main/runtime/orca-runtime-terminal-projection';
    import { buildPreview } from './src/main/runtime/terminal-tail-state';
    import { buildTerminalWaitText } from './src/main/runtime/terminal-wait-tail-state';
    const input = JSON.parse(process.argv[2]);
    async function main() {
      process.stdout.write(JSON.stringify({ phase: 'entered', mode: input.mode }) + '\\n');
      let value;
      if (input.mode === 'window') value = startOfLastNonBlankLines(input.text, input.count);
      if (input.mode === 'blocked') value = detectTerminalWaitBlockedReason(input.text);
      if (input.mode === 'ready') value = isKnownReadyPromptPreview(input.text);
      if (input.mode === 'producer-controls') {
        const emulator = new HeadlessEmulator({ cols: 80, rows: 12, scrollback: 0 });
        try {
          await emulator.write('\\r\\nordinary output\\r\\n');
          const raw = emulator.getVisibleLines();
          const visible = projectTerminalVisibleLines(emulator).lines;
          const tail = projectTerminalTailLines(emulator, 12).lines;
          const longLines = ['prefix', 'x'.repeat(299)];
          const preview = buildPreview(longLines, '');
          const waitText = buildTerminalWaitText(longLines, '', preview);
          value = {
            rawRowsStartBlank: raw[0] === '',
            visibleRows: visible,
            projectedTail: tail,
            visibleClassification: detectTerminalWaitBlockedReason(visible.join('\\n')),
            ordinaryTailClassification: detectTerminalWaitBlockedReason(buildTerminalWaitText(raw, '', '')),
            clippedPreviewStartsNewline: preview.startsWith('\\n'),
            retainedTailStartsNewline: waitText.startsWith('\\n'),
            retainedTailClassification: detectTerminalWaitBlockedReason(waitText),
            emptyTailFallbackStartsNewline: buildTerminalWaitText([], '', preview).startsWith('\\n')
          };
        } finally { emulator.dispose(); }
      }
      process.stdout.write(JSON.stringify({ phase: 'returned', value }) + '\\n');
    }
    main().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `
  const cases = [
    { name: 'leading newline only', mode: 'window', text: '\n', count: 12, expected: 0 },
    { name: 'leading newline and text', mode: 'window', text: '\ntext', count: 12, expected: 0 },
    { name: 'blank screen classification', mode: 'blocked', text: '\n\n', expected: null },
    {
      name: 'leading blank trust dialog',
      mode: 'blocked',
      text: '\nDo you trust this workspace directory?\n1. Yes\n2. No',
      expected: 'agent-trust-workspace'
    },
    {
      name: 'leading blank ready header',
      mode: 'ready',
      text: '\nOpenAI Codex\nmodel: test\ndirectory: /workspace',
      expected: true
    },
    {
      name: 'enough nonblank rows',
      mode: 'window',
      text: '\nfirst\nsecond',
      count: 1,
      expected: 7
    },
    {
      name: 'production producer controls',
      mode: 'producer-controls',
      expected: {
        rawRowsStartBlank: true,
        visibleRows: ['ordinary output'],
        projectedTail: ['ordinary output'],
        visibleClassification: null,
        ordinaryTailClassification: null,
        clippedPreviewStartsNewline: true,
        retainedTailStartsNewline: false,
        retainedTailClassification: null,
        emptyTailFallbackStartsNewline: true
      }
    }
  ]
  const results = {}
  for (const [label, source] of Object.entries({ before: baseline, after: current })) {
    const childPath = join(scratch, `${label}.cjs`)
    await build({
      stdin: { contents: entry, resolveDir: root },
      outfile: childPath,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'terminal-wait-baseline',
          setup(builder) {
            builder.onLoad({ filter: /terminal-wait-tail-window\.ts$/ }, (args) =>
              resolve(args.path) === absoluteSource ? { contents: source, loader: 'ts' } : null
            )
          }
        }
      ]
    })
    results[label] = []
    for (const input of cases) {
      let childTerminated = false
      const started = performance.now()
      const result = await runProcess({
        program: process.execPath,
        args: ['--max-old-space-size=128', childPath, JSON.stringify(input)],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' },
        timeoutMs: 2_000,
        maxOutputBytes: 8192,
        onChildTerminated: () => {
          childTerminated = true
        }
      })
      const output = result.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
      const expectedTimeout = label === 'before' && cases.indexOf(input) < 5
      const returned = output.find((event) => event.phase === 'returned')
      if (
        !childTerminated ||
        result.timedOut !== expectedTimeout ||
        !output.some((event) => event.phase === 'entered')
      ) {
        throw new Error(`Unexpected ${label} result for ${input.name}: ${JSON.stringify(result)}`)
      }
      if (
        !expectedTimeout &&
        (result.code !== 0 ||
          !returned ||
          ('expected' in input && !isDeepStrictEqual(returned.value, input.expected)))
      ) {
        throw new Error(
          `Unexpected ${label} output for ${input.name}: ${result.stdout} ${result.stderr}`
        )
      }
      results[label].push({
        name: input.name,
        timedOut: result.timedOut,
        childTerminated,
        code: result.code,
        signal: result.signal,
        elapsedMs: Math.round(performance.now() - started),
        ...(returned ? { value: returned.value } : {})
      })
    }
  }
  const tag = await runProcess({
    program: 'git',
    args: ['show', `v1.4.198:${sourcePath}`],
    cwd: root,
    maxOutputBytes: 16_384
  })
  const provenance = await runProcess({
    program: 'git',
    args: ['rev-parse', 'HEAD'],
    cwd: root,
    maxOutputBytes: 1024
  })
  process.stdout.write(
    `${JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        revision: provenance.stdout.trim(),
        source: sourcePath,
        hashes: {
          before: sha256(baseline),
          after: sha256(current),
          reportedVersion: tag.code === 0 ? sha256(tag.stdout) : null
        },
        supportingSourceHashes,
        reportedVersionSourceMatchesBaseline: tag.code === 0 && tag.stdout === baseline,
        childTimeoutMs: 2000,
        childHeapLimitMiB: 128,
        scope:
          'Helper termination and producer controls; no incident attribution or retained-byte claim.',
        results
      },
      null,
      2
    )}\n`
  )
} finally {
  if (runnerId) {
    delete require.cache[runnerId]
  }
  await rm(scratch, { recursive: true, force: true })
}
