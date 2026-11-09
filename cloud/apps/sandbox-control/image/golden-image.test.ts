import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VM_SCRIPTS, buildGoldenImage, resolveReleaseBundle, type BuildInputs } from './golden-image'
import { renderVmScriptsModule } from './generate-vm-scripts'

const manifest: BuildInputs['manifest'] = {
  imageVersion: '2026-11-08.1',
  image: 'vercel/sandbox/node:24',
  region: 'iad1',
  vcpus: 4,
  orcad: { bundleUrl: 'https://artifacts.onorca.dev/orcad-linux-x64.tgz', sha256: 'a'.repeat(64) },
  gh: { version: null, sha256: null },
  chrome: null,
  agentCliPackages: ['@anthropic-ai/claude-code@2.1.319', '@openai/codex@0.166.0']
}

function inputs(overrides: Partial<BuildInputs> = {}): BuildInputs {
  return {
    manifest,
    provisionScript: 'echo provision',
    vmScripts: Object.fromEntries(VM_SCRIPTS.map((name) => [name, `#!/bin/sh\n# ${name}\n`])) as BuildInputs['vmScripts'],
    buildId: 'b1',
    ...overrides
  }
}

function fakeProvider(answers: { provisionExit?: number; wipeStdout?: string } = {}) {
  const calls: string[] = []
  const provider = {
    async createBuildSandbox(params: { name: string; image: string }) {
      calls.push(`create ${params.name} ${params.image}`)
      return {
        sandbox: { name: params.name, status: 'running' as const, currentSessionId: 's1', currentSnapshotId: null, tags: {} },
        session: { id: 's1', status: 'running' as const, startedAt: 0, timeoutMs: 0 },
        routes: []
      }
    },
    async runCommand(_session: string, params: { command: string; env?: Record<string, string> }) {
      calls.push(`run ${params.command}`)
      if (params.command === 'bash') {
        expect(params.env?.ORCAD_BUNDLE_SHA256).toBe('a'.repeat(64))
        expect(Buffer.from(params.env!.ORCA_VM_SCRIPT_orca_sandbox_start!, 'base64').toString()).toContain('orca-sandbox-start')
        return { exitCode: answers.provisionExit ?? 0, stdout: '{"node":"v24.11.0","tools":{}}\n', stderr: 'boom' }
      }
      return { exitCode: 0, stdout: answers.wipeStdout ?? '{"wiped":true}\n', stderr: '' }
    },
    async createSnapshot(_session: string, expirationMs: number) {
      calls.push(`snapshot expiration=${expirationMs}`)
      return 'snap_golden_1'
    },
    async deleteBuildSandbox(name: string) {
      calls.push(`delete ${name}`)
    }
  }
  return { provider, calls }
}

describe('golden image build', () => {
  it('wipes identity before snapshotting, keeps the snapshot and deletes the build sandbox', async () => {
    const { provider, calls } = fakeProvider()
    const result = await buildGoldenImage(provider, inputs())
    expect(result).toEqual({ imageVersion: '2026-11-08.1', snapshotId: 'snap_golden_1', report: { node: 'v24.11.0', tools: {} } })
    expect(calls).toEqual([
      'create orca-golden-2026-11-08-1-b1 vercel/sandbox/node:24',
      'run bash',
      'run /opt/orca/bin/orca-image-wipe',
      'snapshot expiration=0',
      'delete orca-golden-2026-11-08-1-b1'
    ])
  })

  it('never snapshots a failed provision or an unconfirmed wipe, and still removes the build sandbox', async () => {
    for (const answers of [{ provisionExit: 1 }, { wipeStdout: '' }]) {
      const { provider, calls } = fakeProvider(answers)
      await expect(buildGoldenImage(provider, inputs())).rejects.toThrow()
      expect(calls.some((call) => call.startsWith('snapshot'))).toBe(false)
      expect(calls.at(-1)).toBe('delete orca-golden-2026-11-08-1-b1')
    }
  })

  it('refuses to build without a pinned orcad bundle', async () => {
    const { provider, calls } = fakeProvider()
    const unpinned = inputs({ manifest: { ...manifest, orcad: { bundleUrl: null, sha256: null } } })
    await expect(buildGoldenImage(provider, unpinned)).rejects.toThrow(/orcad.bundleUrl/)
    expect(calls).toEqual([])
  })

  it('start script: background children never keep the start lock (resume of a running VM hung 60 s)', () => {
    const start = readFileSync(fileURLToPath(new URL('./vm/orca-sandbox-start', import.meta.url).href), 'utf8')
    const launches = start.split('\n').filter((line) => /&\s*$/.test(line) && !/&&\s*$/.test(line))
    expect(launches.length).toBeGreaterThanOrEqual(2)
    for (const line of launches) {
      expect(line, line).toMatch(/9>&- &\s*$/)
    }
  })

  it('ships VM scripts that parse', () => {
    for (const script of ['provision-golden.sh', ...VM_SCRIPTS.map((name) => `vm/${name}`)]) {
      const path = fileURLToPath(new URL(`./${script}`, import.meta.url).href)
      // Node entry points (shebang `env node`) parse with node, the rest with bash.
      const isNode = readFileSync(path, 'utf8').startsWith('#!/usr/bin/env node')
      expect(spawnSync(isNode ? process.execPath : 'bash', isNode ? ['--check', path] : ['-n', path]).status, script).toBe(0)
    }
  })

  it('pins a released orca-server tarball by its published checksum', async () => {
    const sums = `${'b'.repeat(64)}  orca-server-linux-arm64.tar.gz\n${'c'.repeat(64)}  orca-server-linux-x64.tar.gz\n`
    const pinned = await resolveReleaseBundle('v1.4.256', 'x64', async () => new Response(sums))
    expect(pinned).toEqual({
      bundleUrl: 'https://github.com/stablyai/orca/releases/download/v1.4.256/orca-server-linux-x64.tar.gz',
      sha256: 'c'.repeat(64)
    })
    await expect(resolveReleaseBundle('v1.4.254', 'x64', async () => new Response('', { status: 404 }))).rejects.toThrow(/source build/)
  })
})

describe('Worker-embedded image scripts', () => {
  it('match image/ (run image/generate-vm-scripts.ts after editing a script)', () => {
    const generated = readFileSync(fileURLToPath(new URL('./vm-scripts.generated.ts', import.meta.url).href), 'utf8')
    expect(generated).toBe(renderVmScriptsModule())
  })
})
