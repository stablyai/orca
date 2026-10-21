import type { Dispatch, SetStateAction } from 'react'
import type { MountAdapter } from '../recording-scenario'
import { hookMount, performHookAction } from '../hook-mount'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKTREE_ID = 'worktree-1'
const PAGE_ID = 'page-1'
const LAYOUT = { width: 390, height: 700, pageX: 0, pageY: 0 }
const FRAME_METADATA = { deviceWidth: 390, deviceHeight: 700, pageScaleFactor: 1 }

/**
 * The hosted browser's pointer, keyboard and dialog commands, mounted over the real page-request
 * hook rather than a stand-in: the commands hook takes its sender as an argument, so supplying one
 * here would leave the send the migration moves outside the recording.
 */
export function browserMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'browser.page-commands': ({ client, effect }) => {
      const useRequest = modules.load<typeof import('../../../browser/use-mobile-browser-request')>(
        'mobile/src/browser/use-mobile-browser-request.ts'
      ).useMobileBrowserRequest
      const useCommands = modules.load<
        typeof import('../../../browser/use-mobile-browser-commands')
      >('mobile/src/browser/use-mobile-browser-commands.ts').useMobileBrowserCommands
      const busyRef = { current: false }
      let busy = false
      let error: string | null = null
      let dialog: { dialogType: string; message: string } | null = null
      let keyboardValue = 'hello'
      let pointerModifiers: string[] = []
      // React's own setter shape, so the recorder reads an updater the way the hook writes one.
      const setter =
        <T>(read: () => T, write: (value: T) => void): Dispatch<SetStateAction<T>> =>
        (next) =>
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: SetStateAction's function arm is exactly this updater; the typeof check is what narrows it.
          write(typeof next === 'function' ? (next as (prev: T) => T)(read()) : next)
      let commands: ReturnType<typeof useCommands>
      const hook = hookMount(() => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies plain setters where the hook declares React dispatchers.
        const { pageParams, sendBrowserRequest } = useRequest({
          busyRef,
          client,
          pageId: PAGE_ID,
          setBusy: setter(
            () => busy,
            (value) => {
              busy = value
            }
          ),
          setError: setter(
            () => error,
            (value) => {
              error = value
            }
          ),
          worktreeId: WORKTREE_ID
        } as unknown as Parameters<typeof useRequest>[0])
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the recorder supplies only the refs, setters and geometry the commands hook reads.
        commands = useCommands({
          client,
          frameMetadataRef: { current: FRAME_METADATA },
          keyboardValue,
          layoutRef: { current: LAYOUT },
          onToast: (message: string) => effect('toast', { message }),
          pageParams,
          pointerModifiers,
          sendBrowserRequest,
          setDialog: setter(
            () => dialog,
            (value) => {
              dialog = value
            }
          ),
          setError: setter(
            () => error,
            (value) => {
              error = value
            }
          ),
          setKeyboardValue: setter(
            () => keyboardValue,
            (value) => {
              keyboardValue = value
            }
          ),
          setPointerModifiers: setter(
            () => pointerModifiers,
            (value) => {
              pointerModifiers = value
            }
          ),
          zoomRef: { current: { scale: 1, offsetX: 0, offsetY: 0 } }
        } as unknown as Parameters<typeof useCommands>[0])
      })
      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'keyboard-text') {
            return performHookAction(() => commands.sendKeyboardText())
          }
          if (name === 'keypress') {
            return performHookAction(() => commands.sendKeypress(String(args.key ?? 'Enter')))
          }
          if (name === 'dialog') {
            return performHookAction(() =>
              commands.sendDialogCommand(
                args.accept === false ? 'browser.dialogDismiss' : 'browser.dialogAccept'
              )
            )
          }
          if (name === 'wheel') {
            return performHookAction(() => commands.sendWheel({ x: 40, y: 80 }, 0, 120, 1))
          }
          if (name === 'click') {
            return performHookAction(() =>
              commands.sendPointerClick(
                { x: 40, y: 80 },
                args.button === 'right' ? 'right' : 'left'
              )
            )
          }
          throw new Error(`Unknown browser command action: ${name}`)
        },
        state: () => ({
          busy,
          error,
          dialog,
          keyboardValue,
          pointerModifiers: [...pointerModifiers]
        }),
        dispose: hook.unmount
      }
    }
  }
}
