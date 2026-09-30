import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { MOUNTED_OPERATION_MODULES } from './adapters/mounted-operation-modules'
import { operationModuleLoader } from './operation-module-loader'
import { ADAPTER_DIRECTORY } from './recorder-digest'
import type { MountedOperationModule } from './mounted-operation-module'
import type { RecordingScenario } from './recording-scenario'

const digests = new Map<string, string>()

/**
 * Which module mounts each operation, read off the same `mounts` calls that build the table a
 * recording runs against. A restated map could agree with itself while naming the wrong source.
 */
export function adapterSourceByOperation(
  root: string,
  registered: readonly MountedOperationModule[] = MOUNTED_OPERATION_MODULES
): Map<string, string> {
  const modules = operationModuleLoader(root)
  const owners = new Map<string, string>()
  for (const module of registered) {
    for (const operation of Object.keys(module.mounts(modules, {}))) {
      owners.set(operation, module.source)
    }
  }
  return owners
}

/**
 * The adapter source one golden was recorded through: the module mounting each operation its
 * scenarios drive, deduplicated and ordered by file name.
 *
 * Pinned per golden rather than over the whole `adapters/` directory so a domain that adds its
 * module moves nothing that was already recorded, and editing a module fails exactly the goldens
 * that mounted it. A golden whose operation no module mounts has no runner to be attributed to,
 * so it throws rather than digesting an empty set.
 */
export function adapterSha256(
  root: string,
  scenarios: readonly RecordingScenario[],
  registered: readonly MountedOperationModule[] = MOUNTED_OPERATION_MODULES
): string {
  const owners = adapterSourceByOperation(root, registered)
  const sources = [
    ...new Set(
      scenarios.map((scenario) => {
        const source = owners.get(scenario.operation)
        if (source === undefined) {
          throw new Error(`No adapter module mounts ${scenario.operation}`)
        }
        return source
      })
    )
  ].sort()
  const key = `${root}\0${sources.join('\0')}`
  const cached = digests.get(key)
  if (cached !== undefined) {
    return cached
  }
  const digest = createHash('sha256')
    .update(
      sources
        .map(
          (source) =>
            `${source}:${readFileSync(join(root, ...ADAPTER_DIRECTORY.split(posix.sep), source))}`
        )
        .join('\n')
    )
    .digest('hex')
  digests.set(key, digest)
  return digest
}
