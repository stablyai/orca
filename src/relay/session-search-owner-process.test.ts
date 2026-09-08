import { afterEach, expect, it, vi } from 'vitest'
import { build } from 'esbuild'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { RelayAiVaultServiceClient } from './ai-vault-service-client'
import { buildRelayAiVaultServiceEnv } from '../main/ai-vault/session-scanner-service-env'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import type { RelayPlatform } from '../main/ssh/relay-protocol'

let directory: string | undefined
const clients: RelayAiVaultServiceClient[] = []
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.dispose()))
  if (directory) {
    await rm(directory, { recursive: true, force: true })
  }
})

it('excludes a second scanner process, then releases ownership on owner crash without replaying clear', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-search-process-'))
  const entry = join(directory, 'scanner.cjs')
  await build({
    entryPoints: [resolve('src/relay/ai-vault-service-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent'
  })
  const children: ChildProcess[] = []
  const make = () => {
    const client = new RelayAiVaultServiceClient({
      init: {
        remoteHome: directory!,
        hostPlatform: getRemoteHostPlatform(`${process.platform}-${process.arch}` as RelayPlatform)
      },
      processFactory: () => {
        const child = fork(entry, [], {
          execArgv: [],
          env: {
            ...buildRelayAiVaultServiceEnv(),
            HOME: directory,
            USERPROFILE: directory,
            ORCA_BACKGROUND_LAUNCH: '1'
          },
          stdio: ['ignore', 'ignore', 'pipe', 'ipc']
        })
        children.push(child)
        return child
      }
    })
    clients.push(client)
    return client
  }
  const first = make()
  const second = make()
  await first.search('configure', { enabled: true, paused: true })
  const index = join(directory, '.orca', 'session-search-relay', 'index.sqlite')
  expect(existsSync(index)).toBe(true)
  await expect(second.search('configure', { enabled: false, clearIndex: true })).rejects.toThrow(
    'in use'
  )
  expect(await first.search('status', {})).toMatchObject({ enabled: true, paused: true })
  children[0]!.kill('SIGKILL')
  await vi.waitFor(() => expect(children[0]!.signalCode).toBe('SIGKILL'))
  expect(await second.search('status', {})).toMatchObject({ enabled: true, paused: true })
  expect(existsSync(index)).toBe(true)
  expect(await second.search('configure', { enabled: false, clearIndex: true })).toMatchObject({
    enabled: false,
    applied: true
  })
  expect(existsSync(index)).toBe(false)
})
