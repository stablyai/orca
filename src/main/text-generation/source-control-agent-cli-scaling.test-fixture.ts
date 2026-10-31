import * as fs from 'node:fs'
import * as asyncFs from 'node:fs/promises'
import type { ChildProcess } from '@orca/process-host'
import type { ProcessSpec } from '@orca/process-host/process-spec'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { INSTALLED_PLAN_REPLY } from '../provider-process/provider-process-supervisor'
import { generateConversationNameFromContext } from './commit-message-text-generation'

const { chmodSync, copyFileSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } = fs

export type AttemptEvent = {
  attempt?: string
  failed?: string
  code?: string
  started?: string
  closed?: string
  plan?: {
    type: string
    runtimePathBase: string | null
    candidates: { command: string; runtimeDirectory: string | null }[]
  }
}

type ScalingFixture = {
  children: ChildProcess[]
  advisoryBoundary: {
    command: string
    afterOpen?: (file: asyncFs.FileHandle, close: () => Promise<void>) => void | Promise<void>
  } | null
  preload: string
  specs: ProcessSpec[]
  messages: unknown[]
  handles: asyncFs.FileHandle[]
}

function discoveryReadFileCount(paths: readonly unknown[]): number {
  // Linux's existing process guard proves identity independently of CLI discovery.
  return paths.filter((path) => !/^\/proc\/\d+\/stat$/.test(String(path))).length
}

export function installedNamingScalingContract(
  rootPath: () => string,
  fixture: ScalingFixture,
  readEvents: () => AttemptEvent[],
  lookupMessage: (message: unknown) => boolean
): void {
  it.each([
    { agentId: 'codex', versions: 10 },
    { agentId: 'codex', versions: 100 },
    { agentId: 'claude', versions: 10 },
    { agentId: 'claude', versions: 100 }
  ] as const)(
    'names a chat with $agentId at the last of $versions nvm versions in linear probes',
    async ({ agentId, versions }) => {
      const root = rootPath()
      const inventory = join(root, '.nvm', 'versions', 'node')
      for (let version = 1; version <= versions; version++) {
        mkdirSync(join(inventory, `v20.${version}.0`, 'bin'), { recursive: true })
      }
      const bin = join(inventory, 'v20.1.0', 'bin')
      symlinkSync(process.execPath, join(bin, 'node'))
      const program = join(bin, agentId)
      writeFileSync(
        program,
        `#!/usr/bin/env node
const { realpathSync } = require('node:fs')
if (realpathSync(process.env.PATH.split(':')[0]) !== realpathSync(__dirname)) process.exit(2)
process.stdin.resume()
process.stdin.on('end', () => console.log('Fix login flow'))
`
      )
      chmodSync(program, 0o755)
      const request = async (pathEnv = '/usr/bin:/bin', literal?: string) => {
        const before = fixture.specs.length
        const dirReads = vi.mocked(asyncFs.readdir).mockClear()
        const stats = vi.mocked(asyncFs.stat).mockClear()
        const opens = vi.mocked(asyncFs.open).mockClear()
        vi.mocked(asyncFs.access).mockClear()
        vi.mocked(asyncFs.readFile).mockClear()
        fixture.handles = []
        writeFileSync(`${fixture.preload}.events`, '')
        const result = await generateConversationNameFromContext(
          { firstPrompt: 'Fix login' },
          literal
            ? { agentId: 'custom', model: '', customAgentCommand: `"${literal}"` }
            : { agentId, model: agentId === 'codex' ? 'gpt-5.5' : 'sonnet' },
          {
            kind: 'local',
            cwd: root,
            env: {
              ...process.env,
              PATH: pathEnv,
              ORCA_TEST_ATTEMPTS: join(root, 'attempts'),
              CODEX_HOME: join(root, '.codex'),
              CLAUDE_CONFIG_DIR: join(root, '.claude')
            }
          }
        )
        expect(result).toMatchObject({ success: true, name: 'Fix login flow' })
        expect(fixture.specs.length - before).toBe(1)
        const events = readEvents()
        const enumerations = dirReads.mock.calls.filter(
          ([path]) => String(path) === inventory
        ).length
        const entries = (
          await Promise.all(
            dirReads.mock.results.map(async (result, index) =>
              String(dirReads.mock.calls[index][0]) === inventory && result.type === 'return'
                ? (await result.value).length
                : 0
            )
          )
        ).reduce((sum, count) => sum + count, 0)
        return {
          enumerations,
          entries,
          candidates:
            stats.mock.calls.length +
            opens.mock.calls.length +
            vi.mocked(asyncFs.access).mock.calls.length +
            discoveryReadFileCount(vi.mocked(asyncFs.readFile).mock.calls.map(([path]) => path)) +
            dirReads.mock.calls.length +
            fixture.handles.reduce(
              (sum, file) =>
                sum +
                vi.mocked(file.stat).mock.calls.length +
                vi.mocked(file.read).mock.calls.length +
                vi.mocked(file.close).mock.calls.length,
              0
            ),
          aliasReads: stats.mock.calls.filter(([path]) => String(path).includes('/.nvm/alias/'))
            .length,
          events,
          spec: fixture.specs.at(-1)!,
          reply: events.find((event) => event.plan)?.plan
        }
      }
      const scan = await request(`missing:: relative :${'/missing/'.repeat(120)}:/usr/bin:/bin`)
      expect(scan.enumerations).toBe(1)
      expect(scan.entries).toBe(versions)
      expect(scan.candidates).toBeLessThanOrEqual(versions + 40)
      expect(scan.aliasReads).toBeLessThanOrEqual(11)
      for (const file of fixture.handles) {
        expect(file.stat).toHaveBeenCalledTimes(1)
        expect(file.read).toHaveBeenCalledWith(expect.any(Buffer), 0, 4, 0)
        expect(file.close).toHaveBeenCalledTimes(1)
      }
      expect(
        [
          ...vi.mocked(fs.statSync).mock.calls,
          ...vi.mocked(fs.readdirSync).mock.calls,
          ...vi.mocked(fs.openSync).mock.calls
        ].some(([path]) => String(path).startsWith(inventory))
      ).toBe(false)
      expect(scan.events.filter((event) => event.attempt).length).toBe(1 + versions)
      expect(scan.events.filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: program })
      ])
      expect(fixture.messages.filter((message) => lookupMessage(message))).toHaveLength(1)
      expect(scan.reply).toMatchObject({
        type: INSTALLED_PLAN_REPLY,
        runtimePathBase: expect.any(String),
        candidates: expect.arrayContaining([{ command: program, runtimeDirectory: bin }])
      })
      const serialized = JSON.stringify(scan.reply)
      expect(serialized.split('runtimePathBase').length).toBe(2)
      expect(serialized).not.toContain('"PATH":')
      const launchSpec = JSON.parse(
        Buffer.from(scan.spec.env!.ORCA_PROVIDER_SUPERVISOR_SPEC!, 'base64').toString()
      )
      expect(launchSpec).toMatchObject({ installedFallback: true })
      expect(launchSpec).not.toHaveProperty('candidates')
      expect(JSON.stringify(launchSpec).length).toBeLessThan(512)

      if (agentId === 'codex' && versions === 10) {
        expect(discoveryReadFileCount(['/proc/123/stat'])).toBe(0)
        const discoveryPaths = [
          join(root, '.nvm', 'alias', 'default'),
          join(root, 'proc', '123', 'stat'),
          '/proc/self/stat',
          '/proc/123/statm',
          '/proc/123/stat/child'
        ]
        expect(discoveryReadFileCount(discoveryPaths)).toBe(discoveryPaths.length)
        expect(await request(`${bin}:/usr/bin:/bin`)).toMatchObject({ enumerations: 0, entries: 0 })
        expect(await request('/usr/bin:/bin', program)).toMatchObject({
          enumerations: 0,
          entries: 0,
          candidates: 0,
          aliasReads: 0
        })
        const newer = join(inventory, 'v20.10.0', 'bin', agentId)
        copyFileSync(program, newer)
        symlinkSync(process.execPath, join(inventory, 'v20.10.0', 'bin', 'node'))
        expect((await request()).events.some((event) => event.started === newer)).toBe(true)
        unlinkSync(newer)
        expect((await request()).events.some((event) => event.started === program)).toBe(true)
      }
    }
  )
  it.each(['codex', 'claude'] as const)(
    'names with %s when an unused later candidate close rejects',
    async (agentId) => {
      const root = rootPath()
      const [first, later] = ['v20.2.0', 'v20.1.0'].map((version) => {
        const bin = join(root, '.nvm/versions/node', version, 'bin')
        mkdirSync(bin, { recursive: true })
        const command = join(bin, agentId)
        writeFileSync(command, '#!/bin/sh\necho Working title\n', { mode: 0o755 })
        symlinkSync(process.execPath, join(bin, 'node'))
        return command
      })
      let realCloses = 0
      let childCloses = 0
      fixture.advisoryBoundary = {
        command: later,
        afterOpen: (file, close) => {
          fixture.children[0].once('close', () => childCloses++)
          vi.mocked(file.close).mockImplementationOnce(async () => {
            await close()
            realCloses++
            throw new Error('advisory close failed after release')
          })
        }
      }
      await expect(
        generateConversationNameFromContext(
          { firstPrompt: 'Fix login' },
          { agentId, model: agentId === 'codex' ? 'default' : 'sonnet' },
          { kind: 'local', cwd: root, env: { PATH: join(root, 'absent') } }
        )
      ).resolves.toMatchObject({ success: true, name: 'Working title' })
      const events = readEvents()
      const plans = events.filter((event) => event.plan)
      expect(plans).toHaveLength(1)
      expect(plans[0].plan?.candidates.slice(0, 2)).toEqual([
        { command: first, runtimeDirectory: join(first, '..') },
        { command: later, runtimeDirectory: join(later, '..') }
      ])
      expect(events.filter((event) => event.attempt).map((event) => event.attempt)).toEqual([
        agentId,
        first
      ])
      expect(events.filter((event) => event.started)).toEqual([
        expect.objectContaining({ started: first })
      ])
      expect(childCloses).toBe(1)
      expect(fixture.specs).toHaveLength(1)
      expect(fixture.children).toHaveLength(1)
      expect(fixture.messages.filter(lookupMessage)).toHaveLength(1)
      expect(
        fixture.messages.filter(
          (message) => typeof message === 'object' && message !== null && 'pgid' in message
        )
      ).toHaveLength(1)
      const opens = vi.mocked(asyncFs.open)
      const commandHandles = await Promise.all(
        opens.mock.results.flatMap((result, index) =>
          result.type === 'return' && [first, later].includes(String(opens.mock.calls[index][0]))
            ? [result.value]
            : []
        )
      )
      expect(commandHandles).toHaveLength(2)
      for (const file of commandHandles) {
        expect(file.close).toHaveBeenCalledTimes(1)
        expect(file.fd).toBe(-1)
      }
      expect(realCloses).toBe(1)
      const child = fixture.children[0]
      expect(child.exitCode).toBe(0)
      expect(child.signalCode).toBeNull()
      expect(child.listenerCount('message')).toBe(0)
    }
  )
}
