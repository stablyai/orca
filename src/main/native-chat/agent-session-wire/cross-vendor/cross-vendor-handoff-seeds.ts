// The context a cross-vendor switch owes a chat's new agent, kept on disk until a turn carries it,
// so a restart between the switch and the next message still hands it over.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  StructuredAgentSessionTurnContext,
  StructuredAgentSessionTurnContextPlan
} from '../structured-agent-session-turn-context'

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/

export type CrossVendorHandoffSeeds = {
  put: (sessionId: string, text: string) => Promise<void>
  read: (sessionId: string) => Promise<string | null>
  consume: (sessionId: string) => Promise<void>
}

export function createCrossVendorHandoffSeeds(stateDirectory: string): CrossVendorHandoffSeeds {
  const folder = join(stateDirectory, 'cross-vendor-handoffs')
  const cache = new Map<string, string | null>()
  const fileOf = (sessionId: string): string => {
    // Session ids name files; anything else could walk out of the folder.
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('invalid session id')
    }
    return join(folder, `${sessionId}.txt`)
  }
  return {
    put: async (sessionId, text) => {
      const file = fileOf(sessionId)
      await mkdir(folder, { recursive: true })
      await writeFile(file, text, 'utf8')
      cache.set(sessionId, text)
    },
    read: async (sessionId) => {
      if (!SESSION_ID_PATTERN.test(sessionId)) {
        return null
      }
      if (cache.has(sessionId)) {
        return cache.get(sessionId) ?? null
      }
      const text = await readFile(fileOf(sessionId), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') {
            throw error
          }
          return null
        }
      )
      cache.set(sessionId, text)
      return text
    },
    consume: async (sessionId) => {
      cache.set(sessionId, null)
      if (SESSION_ID_PATTERN.test(sessionId)) {
        await rm(fileOf(sessionId), { force: true }).catch(() => {})
      }
    }
  }
}

let installed: CrossVendorHandoffSeeds | null = null

export function installCrossVendorHandoffSeeds(seeds: CrossVendorHandoffSeeds): void {
  installed = seeds
}

export function getCrossVendorHandoffSeeds(): CrossVendorHandoffSeeds | null {
  return installed
}

function withSeed(
  seed: string,
  sessionId: string,
  seeds: CrossVendorHandoffSeeds,
  base: StructuredAgentSessionTurnContextPlan | null
): StructuredAgentSessionTurnContextPlan {
  return {
    ...base,
    text: [seed, base?.text].filter(Boolean).join('\n\n'),
    given: (receipt) => {
      void seeds.consume(sessionId)
      base?.given(receipt)
    }
  }
}

/** The host's turn context, with a pending hand-off riding first on the next turn it carries. */
export function withCrossVendorHandoffTurnContext(
  inner: StructuredAgentSessionTurnContext | undefined,
  seeds: CrossVendorHandoffSeeds
): StructuredAgentSessionTurnContext {
  const seeded = async (
    sessionId: string,
    read: () => Promise<StructuredAgentSessionTurnContextPlan | null>
  ): Promise<StructuredAgentSessionTurnContextPlan | null> => {
    const [seed, base] = await Promise.all([seeds.read(sessionId), read()])
    return seed ? withSeed(seed, sessionId, seeds, base) : base
  }
  return {
    ...inner,
    plan: (sessionId, ...args) =>
      seeded(sessionId, () => inner?.plan(sessionId, ...args) ?? Promise.resolve(null)),
    launchUpdate: (sessionId, held) =>
      seeded(sessionId, () => inner?.launchUpdate?.(sessionId, held) ?? Promise.resolve(null))
  }
}
