import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRexLaunchPlan } from './rex-launch-plan'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRexLaunchPayloadFactory } from './rex-launch-worker'

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'Rex launch environment',
  () => {
    afterEach(() => vi.unstubAllEnvs())
    it('scrubs inherited pane identity and capabilities while preserving explicit launch configuration', () => {
      vi.stubEnv('ORCA_PANE_KEY', 'old-pane')
      vi.stubEnv('ORCA_TAB_ID', 'old-tab')
      vi.stubEnv('OSC7577_TOKEN', 'old-capability')
      vi.stubEnv('REX_TEST_CAPABILITY', 'old-server')
      vi.stubEnv('NODE_ENV', 'production')
      vi.stubEnv('ORCA_HISTFILE', '/old-history')
      vi.stubEnv('REX_TEST_DELETE', undefined)
      vi.stubEnv('TEST_DELETE', 'inherited')
      const result = createRexLaunchPlan(
        {
          cols: 80,
          rows: 24,
          shellOverride: '/bin/bash',
          terminalShellArgs: ['--noprofile', '--norc', '-i'],
          env: {
            ORCA_PANE_KEY: 'new-pane',
            CLAUDE_CONFIG_DIR: '/fixture/claude',
            CODEX_HOME: '/fixture/codex'
          },
          envToDelete: ['TEST_DELETE']
        },
        '/tmp'
      )
      expect(result.argv).toEqual(['/bin/bash', '--noprofile', '--norc', '-i'])
      expect(result.env.ORCA_PANE_KEY).toBe('new-pane')
      expect(result.env.CLAUDE_CONFIG_DIR).toBe('/fixture/claude')
      expect(result.env.CODEX_HOME).toBe('/fixture/codex')
      for (const key of [
        'ORCA_TAB_ID',
        'OSC7577_TOKEN',
        'REX_TEST_CAPABILITY',
        'NODE_ENV',
        'ORCA_HISTFILE',
        'TEST_DELETE'
      ]) {
        expect(result.env[key]).toBeUndefined()
      }
    })
    it('reuses only an idle matching planner and isolates concurrent launch cancellation', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rex-planner-test-'))
      try {
        const entry = join(directory, 'planner.cjs')
        await writeFile(
          entry,
          `const { parentPort, workerData, threadId } = require('node:worker_threads')
          parentPort.on('message', ({ id, opts }) => {
            parentPort.postMessage({ id, ok: true, payload: Buffer.from(JSON.stringify({
              threadId, profile: workerData, ambient: process.env.QUALITY_FIXTURE_AMBIENT,
              explicit: opts.env?.QUALITY_FIXTURE_EXPLICIT
            })) })
          })`
        )
        const profileA = join(directory, 'a')
        const profileB = join(directory, 'b')
        const a = createRexLaunchPayloadFactory(entry, profileA)
        const b = createRexLaunchPayloadFactory(entry, profileB)
        async function plan(
          factory: typeof a,
          value: string,
          signal?: AbortSignal
        ): Promise<{ threadId: number; profile: string; ambient: string; explicit: string }> {
          const bytes = await factory(
            { cols: 80, rows: 24, env: { QUALITY_FIXTURE_EXPLICIT: value }, signal },
            directory
          )
          try {
            return JSON.parse(bytes.toString())
          } finally {
            bytes.fill(0)
          }
        }
        vi.stubEnv('QUALITY_FIXTURE_AMBIENT', 'first')
        const first = await plan(a, 'one')
        const second = await plan(a, 'two')
        expect(second).toEqual({ ...first, explicit: 'two' })
        vi.stubEnv('QUALITY_FIXTURE_AMBIENT', 'second')
        const changed = await plan(a, 'three')
        expect(changed).toMatchObject({ profile: profileA, ambient: 'second', explicit: 'three' })
        expect(changed.threadId).not.toBe(first.threadId)
        const other = await plan(b, 'four')
        expect(other.profile).toBe(profileB)
        const parallel = await Promise.all([plan(b, 'five'), plan(b, 'six')])
        expect(parallel.map((item) => item.explicit)).toEqual(['five', 'six'])
        expect(parallel[0].threadId).not.toBe(parallel[1].threadId)
        const controller = new AbortController()
        const cancelled = plan(b, 'cancelled', controller.signal)
        const independent = plan(b, 'independent')
        controller.abort()
        await expect(cancelled).rejects.toThrow('client_disconnected')
        expect((await independent).explicit).toBe('independent')
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
    it('keeps worker exception contents private and recovers after the worker exits', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'rex-planner-fault-'))
      try {
        const entry = join(directory, 'planner.cjs')
        await writeFile(
          entry,
          `const { parentPort, threadId } = require('node:worker_threads')
          parentPort.on('message', ({ id, opts }) => {
            if (opts.env?.QUALITY_FIXTURE_CRASH === 'yes') {
              throw new Error('synthetic-private-worker-error')
            }
            parentPort.postMessage({ id, ok: true, payload: Buffer.from(String(threadId)) })
          })`
        )
        const factory = createRexLaunchPayloadFactory(entry, directory)
        const first = await factory({ cols: 80, rows: 24 }, directory)
        await expect(
          factory({ cols: 80, rows: 24, env: { QUALITY_FIXTURE_CRASH: 'yes' } }, directory)
        ).rejects.toThrow('Rex launch planner worker failed')
        const next = await factory({ cols: 80, rows: 24 }, directory)
        expect(next.toString()).not.toBe(first.toString())
        first.fill(0)
        next.fill(0)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
    })
    it('refuses caller overrides of server capabilities before preparing launch', () => {
      expect(() =>
        createRexLaunchPlan({ cols: 80, rows: 24, env: { OSC7577_TOKEN: 'override' } }, '/tmp')
      ).toThrow('Unsupported')
    })
  }
)
