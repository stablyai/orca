export type LegacyGenerationRetirementAdapter = {
  protocolVersion: number
  retireIfIdle: () => Promise<boolean>
}

export type LegacyGenerationRetirementResult<T extends LegacyGenerationRetirementAdapter> = {
  kept: T[]
  retiredProtocolVersions: number[]
  leaks: { protocolVersion: number; reason: string }[]
}

export async function retireIdleLegacyDaemonGenerations<
  T extends LegacyGenerationRetirementAdapter
>(adapters: readonly T[]): Promise<LegacyGenerationRetirementResult<T>> {
  const kept: T[] = []
  const retiredProtocolVersions: number[] = []
  const leaks: { protocolVersion: number; reason: string }[] = []

  const outcomes = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return { adapter, retired: await adapter.retireIfIdle() }
      } catch (error) {
        return {
          adapter,
          retired: false,
          leak: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )

  for (const outcome of outcomes) {
    if (outcome.retired) {
      console.warn(
        `[daemon] Retired idle previous-generation daemon v${outcome.adapter.protocolVersion}`
      )
      retiredProtocolVersions.push(outcome.adapter.protocolVersion)
    } else {
      kept.push(outcome.adapter)
    }
    if (outcome.leak) {
      console.warn(
        `[daemon] Keeping previous-generation daemon v${outcome.adapter.protocolVersion}; ${outcome.leak}`
      )
      leaks.push({ protocolVersion: outcome.adapter.protocolVersion, reason: outcome.leak })
    }
  }

  return { kept, retiredProtocolVersions, leaks }
}
