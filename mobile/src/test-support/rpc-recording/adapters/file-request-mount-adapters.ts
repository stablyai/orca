import type * as FileMutationOwnershipModule from '../../../files/mutation-ownership/mobile-file-mutation-ownership'
import type * as FilePreviewRequestModule from '../../../files/preview/mobile-file-preview-request'
import type * as FileTabDocModule from '../../../files/session-documents/mobile-file-tab-doc'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
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

export function fileRequestMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'files.mutation-ownership': ({ client }) => {
      const capture = modules.load<typeof FileMutationOwnershipModule>(
        'mobile/src/files/mutation-ownership/mobile-file-mutation-ownership.ts'
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
      const load = modules.load<typeof FilePreviewRequestModule>(
        'mobile/src/files/preview/mobile-file-preview-request.ts'
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
      const save = modules.load<typeof FilePreviewRequestModule>(
        'mobile/src/files/preview/mobile-file-preview-request.ts'
      ).saveMobileTerminalArtifactPreview
      let saved: unknown = 'unsaved'
      return {
        action: (name) =>
          save(client, ARTIFACT, 'next', {
            onTerminalArtifactSourceRefreshed: (source: unknown) =>
              effect('artifact-source-refreshed', source),
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
      const resolve = modules.load<typeof FileTabDocModule>(
        'mobile/src/files/session-documents/mobile-file-tab-doc.ts'
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
