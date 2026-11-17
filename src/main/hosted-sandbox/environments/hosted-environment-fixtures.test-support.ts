import type {
  HostedEnvironmentBuildView,
  HostedEnvironmentListEntry
} from '../../../shared/hosted-sandbox/hosted-environment-wire'

export const ENV_ID = 'env_03b89d4bf1c74787a7ce'
export const BUILD_ID = 'bld_0123456789abcdef'

export function buildView(
  overrides: Partial<HostedEnvironmentBuildView> = {}
): HostedEnvironmentBuildView {
  return {
    id: BUILD_ID,
    number: 3,
    status: 'running',
    active: false,
    createdBy: 'user_1',
    createdAt: 1_700_000_000_000,
    startedAt: 1_700_000_002_000,
    snapshotStartedAt: null,
    finishedAt: null,
    durationMs: null,
    activatable: false,
    error: null,
    failedStep: null,
    revision: 2,
    machineSize: 'standard',
    repos: [{ url: 'https://github.com/acme/web.git', branch: 'main', commit: null }],
    diskUsedBytes: null,
    diskTotalBytes: null,
    logBytes: 0,
    logTruncated: false,
    ...overrides
  }
}

export function environmentEntry(
  overrides: Partial<HostedEnvironmentListEntry> = {}
): HostedEnvironmentListEntry {
  return {
    id: ENV_ID,
    name: 'Web',
    repos: [{ url: 'https://github.com/acme/web.git', defaultBranch: 'main' }],
    installScript: 'pnpm install',
    envVarNames: ['NPM_TOKEN'],
    machineSize: 'standard',
    activeBuildId: null,
    revision: 2,
    createdBy: 'user_1',
    updatedBy: 'user_1',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    activeBuild: null,
    latestBuild: null,
    ...overrides
  }
}

/** A body that yields the given ndjson chunks, then either closes or stays open until aborted. */
export function ndjsonBody(
  chunks: readonly string[],
  options: { hang?: boolean; signal?: AbortSignal } = {}
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index++]))
        return
      }
      if (!options.hang) {
        controller.close()
        return
      }
      return new Promise<void>((resolve) => {
        const fail = (): void => {
          controller.error(new Error('aborted'))
          resolve()
        }
        if (options.signal?.aborted) {
          fail()
        } else {
          options.signal?.addEventListener('abort', fail, { once: true })
        }
      })
    }
  })
}

export const line = (value: unknown): string => `${JSON.stringify(value)}\n`
