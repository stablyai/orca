import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runProcessSync } from '@orca/process-host'
import { NODE_RUNTIME_ASSETS, NODE_RUNTIME_PIN } from '../../../shared/node-runtime-pin'
import { getRemoteHostPlatform } from '../../ssh/ssh-remote-platform'
import {
  hostDownloadNodeRuntimeCommand,
  hostNodeRuntimeUrl,
  readHostNodeDownload
} from './remote-node-runtime-host-download'

const TARGET = 'linux-x64-glibc'
const host = getRemoteHostPlatform('linux-x64')
const PAYLOAD = 'pinned node archive bytes'
const originalAsset = { ...NODE_RUNTIME_ASSETS[TARGET] }
const directories: string[] = []

beforeEach(() => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], {
    archiveSha256: createHash('sha256').update(PAYLOAD).digest('hex')
  })
})
afterEach(() => {
  Object.assign(NODE_RUNTIME_ASSETS[TARGET], originalAsset)
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function which(tool: string): string | null {
  const result = runProcessSync({ program: '/bin/sh', args: ['-c', `command -v ${tool}`] })
  return result.code === 0 ? result.stdout.trim() : null
}

function fakeHost(tools: Record<string, string>): { bin: string; stage: string } {
  const root = mkdtempSync(join(tmpdir(), 'orca-host-download-'))
  directories.push(root)
  const bin = join(root, 'bin')
  const stage = join(root, 'stage')
  mkdirSync(bin)
  mkdirSync(stage)
  for (const basic of ['cut', 'rm', 'head', 'sleep', 'kill', 'sha256sum', 'shasum', 'perl']) {
    const resolved = which(basic)
    if (resolved) {
      symlinkSync(resolved, join(bin, basic))
    }
  }
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  return { bin, stage }
}

const writeTo = (flag: string, content: string): string =>
  `while [ $# -gt 0 ]; do if [ "$1" = ${flag} ]; then printf '%s' '${content}' > "$2"; fi; shift; done`

function runOnHost(
  bin: string,
  stage: string,
  options: { mirror?: string; env?: Record<string, string>; timeoutMs?: number } = {}
): string {
  const command = hostDownloadNodeRuntimeCommand(host, {
    stageDir: stage,
    target: TARGET,
    mirror: options.mirror
  })
  const result = runProcessSync({
    program: '/bin/sh',
    args: ['-c', command],
    env: { PATH: bin, ...options.env },
    timeoutMs: options.timeoutMs ?? 30_000
  })
  expect(result.code, result.stderr).toBe(0)
  return result.stdout
}

const read = (bin: string, name: string): string[] =>
  runProcessSync({ program: '/bin/cat', args: [join(bin, name)] })
    .stdout.trim()
    .split('\n')
const mirrored = (base: string): string =>
  `${base}/v${NODE_RUNTIME_PIN.version}/${originalAsset.archive}`
const curlServing = (prefix: string, failure = "echo 'curl: (22) 404' >&2; exit 22"): string =>
  [
    `prev=; for a in "$@"; do case "$a" in http*) echo "$a" >> "\${0%/*}/urls";; esac;`,
    `[ "$prev" = --max-time ] && echo "$a" >> "\${0%/*}/max-times"; prev=$a; done`,
    `ulimit -f >> "\${0%/*}/file-limit"`,
    `for a in "$@"; do case "$a" in ${prefix}*) ${writeTo('-o', PAYLOAD)}; exit 0;; esac; done`,
    failure
  ].join('\n')

describe.skipIf(process.platform === 'win32')('the host-side pinned Node download', () => {
  it('downloads the release URL with curl and keeps the verified archive', () => {
    const { bin, stage } = fakeHost({ curl: curlServing('https://nodejs.org/') })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({ ok: true })
    expect(existsSync(join(stage, originalAsset.archive))).toBe(true)
    expect(read(bin, 'urls')).toEqual([hostNodeRuntimeUrl(TARGET)])
    // Cap endless downloads at 200 MiB, expressed in 512-byte blocks.
    expect(read(bin, 'file-limit')).toEqual(['409600'])
  })

  it('uses wget where the host has no curl', () => {
    const { bin, stage } = fakeHost({ wget: writeTo('-O', PAYLOAD) })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({ ok: true })
  })

  it(
    'stops a trickling wget at its share of the deadline, without the timeout command',
    { timeout: 90_000 },
    () => {
      const { bin, stage } = fakeHost({
        date: `if [ -e "\${0%/*}/clock" ]; then echo 1809; else : > "\${0%/*}/clock"; echo 1000; fi`,
        wget: 'exec sleep 120'
      })
      const started = Date.now()
      const result = readHostNodeDownload(runOnHost(bin, stage, { timeoutMs: 80_000 }))
      expect(Date.now() - started).toBeLessThan(70_000)
      expect(result).toMatchObject({ ok: false, report: expect.stringContaining('wget exit 143') })
    }
  )

  it('discards a file that is not the pinned release', () => {
    const { bin, stage } = fakeHost({ curl: writeTo('-o', '<html>blocked by policy</html>') })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toMatchObject({ ok: false, report: expect.stringContaining('pinned release') })
    expect(existsSync(join(stage, originalAsset.archive))).toBe(false)
  })

  it("reports each source by name with the tool's own words", () => {
    const { bin, stage } = fakeHost({
      curl: "echo 'curl: (7) Failed to connect to nodejs.org port 443' >&2; exit 7"
    })
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({
      ok: false,
      report:
        'its downloads failed (nodejs.org: curl exit 7, curl: (7) Failed to connect to nodejs.org port 443)'
    })
  })

  it('says so when the host has neither curl nor wget', () => {
    const { bin, stage } = fakeHost({})
    expect(readHostNodeDownload(runOnHost(bin, stage))).toEqual({
      ok: false,
      report: 'it has neither curl nor wget'
    })
  })

  it("tries this computer's mirror first and stops once it serves the pinned file", () => {
    const { bin, stage } = fakeHost({ curl: curlServing('https://desk.example/') })
    const output = runOnHost(bin, stage, { mirror: 'https://desk.example/dist' })
    expect(readHostNodeDownload(output)).toEqual({ ok: true })
    expect(read(bin, 'urls')).toEqual([mirrored('https://desk.example/dist')])
  })

  it("ignores the host's own mirror variables, so only URLs Orca validated are fetched", () => {
    const { bin, stage } = fakeHost({ curl: curlServing('https://nodejs.org/') })
    const output = runOnHost(bin, stage, {
      mirror: 'https://desk.example/dist',
      env: { NODEJS_ORG_MIRROR: 'https://user:secret@host.example/dist[' }
    })
    expect(readHostNodeDownload(output)).toEqual({ ok: true })
    expect(read(bin, 'urls')).toEqual([
      mirrored('https://desk.example/dist'),
      hostNodeRuntimeUrl(TARGET)
    ])
  })

  it('splits the deadline over the sources left, so a stalled mirror leaves time for the release', () => {
    const { bin, stage } = fakeHost({
      date: 'echo 1000',
      curl: curlServing('https://nodejs.org/', "echo 'curl: (28) timed out' >&2; exit 28")
    })
    const output = runOnHost(bin, stage, { mirror: 'https://desk.example/dist' })
    expect(readHostNodeDownload(output)).toEqual({ ok: true })
    expect(read(bin, 'max-times')).toEqual(['420', '840'])
  })

  it('reports a source as not tried once the deadline has passed', () => {
    const { bin, stage } = fakeHost({
      date: `if [ -e "\${0%/*}/clock" ]; then echo 99999; else : > "\${0%/*}/clock"; echo 1000; fi`,
      curl: `touch "\${0%/*}/curl.ran"; exit 7`
    })
    const result = readHostNodeDownload(runOnHost(bin, stage))
    expect(result).toMatchObject({ ok: false, report: expect.stringContaining('out of time') })
    expect(existsSync(join(bin, 'curl.ran'))).toBe(false)
  })
})
