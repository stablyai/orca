import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { record } from './push-owner-integration.test-fixture.js'

export const GATEWAY_RELEASE = '44de854ded418a3c9a29a7c7d8c66dc5c08b0993'
const gatewayFiles = [
  'durable-push-store',
  'push-queued-dismissal',
  'push-delivery-payload',
  'push-delivery-message',
  'push-worker-concurrency',
  'push-background-database',
  'durable-push-worker',
  'push-dispatcher',
  'host-fingerprint',
  'push-schema',
  'durable-push-schema',
  'device-registry-store'
]

// This pin predates occurrence authority. Its external package is its own real wire grammar.
export async function archivedGateway() {
  const repo = resolve(import.meta.dirname, '../../../..')
  const root = await mkdtemp(join(repo, 'cloud/packages/push-contract/src/.gateway-rollout-'))
  const blob = (path: string) =>
    execFileSync('git', ['show', `${GATEWAY_RELEASE}:${path}`], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  try {
    await mkdir(join(root, 'contract'))
    const contractFiles = execFileSync(
      'git',
      ['ls-tree', '--name-only', GATEWAY_RELEASE, 'cloud/packages/push-contract/src/'],
      { cwd: repo, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter((file) => file.endsWith('.ts') && !file.includes('.test.'))
    for (const file of contractFiles) {
      await writeFile(join(root, 'contract', file.split('/').at(-1) ?? ''), blob(file))
    }
    for (const file of gatewayFiles) {
      await writeFile(
        join(root, `${file}.ts`),
        blob(`cloud/apps/push/src/${file}.ts`).replaceAll(
          "'@orca-cloud/push-contract'",
          "'./contract/index.js'"
        )
      )
    }
    const load = async (file: string): Promise<Record<string, unknown>> => {
      const value: unknown = await import(/* @vite-ignore */ join(root, `${file}.ts`))
      return record(value)
    }
    const construct = async (
      file: string,
      symbol: string,
      args: unknown[]
    ): Promise<Record<string, unknown>> => {
      const ctor = (await load(file))[symbol]
      if (typeof ctor !== 'function') {
        throw new Error(`Missing archived ${symbol}`)
      }
      const instance: unknown = Reflect.construct(ctor, args)
      const methods: unknown = Object.getPrototypeOf(instance)
      if (!methods || typeof methods !== 'object') {
        throw new Error('Missing archived prototype')
      }
      return {
        instance,
        ...Object.fromEntries(
          Object.getOwnPropertyNames(methods).map((name): [string, unknown] => [
            name,
            Reflect.get(methods, name)
          ])
        )
      }
    }
    return { root, load, construct, close: () => rm(root, { recursive: true, force: true }) }
  } catch (error) {
    try {
      await rm(root, { recursive: true, force: true })
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Archived gateway cleanup failed', {
        cause: error
      })
    }
    throw error
  }
}

export async function archivedCall(
  object: Record<string, unknown>,
  method: string,
  ...args: unknown[]
): Promise<unknown> {
  const callable = object[method]
  if (typeof callable !== 'function') {
    throw new Error(`Missing archived ${method}`)
  }
  const result: unknown = await callable.call(object.instance ?? object, ...args)
  return result
}
