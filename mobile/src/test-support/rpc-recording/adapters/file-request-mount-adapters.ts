import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
/** The artifact a scenario reads; the path decides which of the two artifact methods it asks. */
function artifactSource(absolutePath: string) {
  return {
    source: 'terminalArtifact' as const,
    worktreeId: WORKSPACE,
    absolutePath,
    grantId: 'grant-1',
    terminalHandle: 'terminal-1',
    pathText: absolutePath.slice(absolutePath.lastIndexOf('/') + 1),
    cwd: '/logs'
  }
}

const ARTIFACT = artifactSource('/logs/run.txt')

/**
 * The file reads and writes a session file tab runs: ownership capture before a mutation, the
 * preview loader with its terminal-artifact grant refresh, the artifact save, and the tab doc's
 * three shapes. Each is an exported async function taking a client, so the recorded state is the
 * function's own answer and no React host is needed.
 */
export function fileRequestMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'files.mutation-ownership': ({ client }) => {
      const capture = modules.load<typeof import('../../../files/mobile-file-mutation-ownership')>(
        'mobile/src/files/mobile-file-mutation-ownership.ts'
      ).captureMobileFileMutationOwnership
      let ownership: unknown = 'uncaptured'
      return {
        action: () =>
          capture(client, `id:${WORKSPACE}`).then((value: unknown) => {
            ownership = value
            return value
          }),
        state: () => ({ ownership }),
        dispose: () => {}
      }
    },
    'files.preview-load': ({ client, effect }) => {
      const load = modules.load<typeof import('../../../files/mobile-file-preview-request')>(
        'mobile/src/files/mobile-file-preview-request.ts'
      ).loadMobileFilePreview
      let preview: unknown = 'unloaded'
      return {
        action(name, args) {
          const request =
            name === 'worktree'
              ? load(client, WORKSPACE, String(args.path ?? 'docs/readme.md'))
              : load(client, artifactSource(String(args.path ?? '/logs/run.txt')), undefined, {
                  onTerminalArtifactSourceRefreshed: (source: unknown) =>
                    effect('artifact-source-refreshed', source)
                })
          return request.then((value: unknown) => {
            preview = value
            return value
          })
        },
        state: () => ({ preview }),
        dispose: () => {}
      }
    },
    'files.preview-save': ({ client, effect }) => {
      const save = modules.load<typeof import('../../../files/mobile-file-preview-request')>(
        'mobile/src/files/mobile-file-preview-request.ts'
      ).saveMobileTerminalArtifactPreview
      let saved: unknown = 'unsaved'
      return {
        action: (name) =>
          save(client, ARTIFACT, 'next', {
            onTerminalArtifactSourceRefreshed: (source: unknown) =>
              effect('artifact-source-refreshed', source),
            // The verified arm re-reads the artifact first; the blind arm writes straight away.
            ...(name === 'blind' ? {} : { baseContent: 'base' })
          }).then((value: unknown) => {
            saved = value
            return value
          }),
        state: () => ({ saved }),
        dispose: () => {}
      }
    },
    'files.tab-doc': ({ client }) => {
      const resolve = modules.load<typeof import('../../../files/mobile-file-tab-doc')>(
        'mobile/src/files/mobile-file-tab-doc.ts'
      ).resolveMobileFileTabDoc
      const docs: Record<string, unknown> = {}
      return {
        action: (name) =>
          resolve(client, {
            worktreeId: WORKSPACE,
            relativePath: name === 'image' ? 'docs/logo.png' : 'docs/readme.md',
            ...(name === 'diff' ? { diffSource: 'staged' as const } : {})
          }).then((value: unknown) => {
            docs[name] = value
            return value
          }),
        state: () => ({ ...docs }),
        dispose: () => {}
      }
    }
  }
}
