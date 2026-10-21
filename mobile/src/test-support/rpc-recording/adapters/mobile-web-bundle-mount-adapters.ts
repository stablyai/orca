import type { MountAdapter, MountContext } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const OPERATIONS_MODULE = 'mobile/src/transport/mobile-web-bundle-operations.ts'
const FETCH_MODULE = 'mobile/src/transport/mobile-web-bundle-fetch.ts'
const RPC_OPERATION_MODULE = 'mobile/src/transport/rpc-operation.ts'

type OperationsModule = typeof import('../../../transport/mobile-web-bundle-operations')
type FetchModule = typeof import('../../../transport/mobile-web-bundle-fetch')
type RpcOperationModule = typeof import('../../../transport/rpc-operation')

/** The host's own code where it has one, so the projection observes the code reader too. */
function describeFailure(operations: OperationsModule, error: unknown): string {
  const code = operations.readMobileWebBundleErrorCode(error)
  if (code !== null) {
    return `refused: ${code}`
  }
  return `failed: ${error instanceof Error ? error.message : String(error)}`
}

/**
 * The two client reads that fetch the desktop-served mobile web bundle.
 *
 * `bundle-manifest` drives the manifest descriptor alone, so the loose reader's verdict on one reply
 * is the whole observation. `bundle-fetch` drives the paging flow, and its state carries the decoded
 * bytes of every asset rather than a count: a reassembly that misplaces a chunk still has the right
 * length, and only the bytes say so.
 */
export function mobileWebBundleMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'mobileWeb.bundle-manifest': ({ client }: MountContext) => {
      const operations = modules.load<OperationsModule>(OPERATIONS_MODULE)
      const runRpcOperation = modules.load<RpcOperationModule>(RPC_OPERATION_MODULE).runRpcOperation
      let outcome: unknown = 'unread'
      return {
        action() {
          const started = runRpcOperation(client, operations.mobileWebBundleManifestRead, null)
          started.then(
            (reply) => {
              outcome = {
                chunkBytes: reply.chunkBytes,
                buildId: reply.manifest.buildId,
                entrypoint: reply.manifest.entrypoint,
                paths: reply.manifest.assets.map((asset) => asset.path)
              }
            },
            (error: unknown) => {
              outcome = describeFailure(operations, error)
            }
          )
          return started
        },
        state: () => ({ outcome }),
        dispose: () => {}
      }
    },
    'mobileWeb.bundle-fetch': ({ client, effect }: MountContext) => {
      const operations = modules.load<OperationsModule>(OPERATIONS_MODULE)
      const fetchMobileWebBundle = modules.load<FetchModule>(FETCH_MODULE).fetchMobileWebBundle
      let outcome: unknown = 'unfetched'
      let assets: unknown = null
      return {
        action() {
          // Projected rather than returned whole: the result carries a Map of Uint8Arrays, and the
          // observation refuses a non-plain object, which loses the settlement and files an
          // unhandled rejection in its place.
          return fetchMobileWebBundle({
            client,
            onProgress: (progress) => {
              effect('bundle-progress', {
                completedAssets: progress.completedAssets,
                totalAssets: progress.totalAssets,
                receivedBytes: progress.receivedBytes
              })
            }
          }).then(
            (fetched) => {
              outcome = {
                buildId: fetched.manifest.buildId,
                assetCount: fetched.assets.size,
                totalBytes: fetched.totalBytes
              }
              assets = Object.fromEntries(
                [...fetched.assets].map(([path, bytes]) => [path, new TextDecoder().decode(bytes)])
              )
              return outcome
            },
            (error: unknown) => {
              outcome = describeFailure(operations, error)
              throw error
            }
          )
        },
        state: () => ({ outcome, assets }),
        dispose: () => {}
      }
    }
  }
}
