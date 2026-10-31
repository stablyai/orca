import { WebContentsView, type BaseWindow, type BrowserWindow, type WebContents } from 'electron'
import { HOLD_QUIT_DURATION_MS, type HoldQuitNotice } from '../../shared/mac-hold-quit'
import { translateMain } from '../i18n/main-i18n'
import {
  registerNativePopupQuitSurface,
  type NativePopupQuitSurface
} from './native-browser-popup-windows'
import { describeCommittedPopupOrigin } from './popup-committed-origin'

export const POPUP_ORIGIN_BAR_HEIGHT = 34
const QUIT_NOTICE_HEIGHT = 64

// Same main.css tokens as the existing isolated origin bar, which cannot import renderer CSS.
export const POPUP_ORIGIN_BAR_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root { color-scheme: light dark; }
  body { margin: 0; height: 100vh; box-sizing: border-box; overflow: hidden;
    -webkit-user-select: none; user-select: none; cursor: default;
    font: 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    background: #fff; color: #0a0a0a; border-bottom: 1px solid #e5e5e5; }
  #identity { height: 34px; padding: 0 10px; display: flex; align-items: center; gap: 8px; white-space: nowrap; }
  #insecure { display: none; color: #e40014; font-weight: 600; }
  body.insecure #insecure { display: inline; }
  #origin-clip { overflow: hidden; text-overflow: ellipsis; direction: rtl; }
  #origin { unicode-bidi: isolate; direction: ltr; }
  #hold-notice { padding: 0 10px 8px; box-sizing: border-box; }
  #hold-hint { margin: 0 0 8px; }
  #hold-progress { width: 100%; height: 4px; accent-color: currentColor; }
  @media (prefers-color-scheme: dark) {
    body { background: #0a0a0a; color: #fafafa; border-bottom-color: rgb(255 255 255 / 0.07); }
    #insecure { color: #ff6568; }
  }
</style></head><body><div id="identity"><span id="insecure">Not secure</span><span id="origin-clip"><bdi id="origin"></bdi></span></div><div id="hold-notice" role="status" hidden><p id="hold-hint"></p><progress id="hold-progress" max="100" value="0" hidden></progress></div></body></html>`

function createPresenter(bar: WebContents, activeChanged: (active: boolean) => void) {
  let latest: HoldQuitNotice | null = null
  let loaded = false
  let disposed = false
  const render = (): void => {
    if (!loaded || disposed || !latest || bar.isDestroyed()) {
      return
    }
    const payload = {
      ...latest,
      duration: HOLD_QUIT_DURATION_MS,
      hint:
        latest.phase === 'unavailable'
          ? translateMain(
              'holdQuit.unavailable',
              'Hold-to-quit is unavailable. Use the application menu to quit.'
            )
          : translateMain('holdQuit.hint', 'Agents are still working. Hold ⌘Q to quit.')
    }
    void bar
      .executeJavaScript(`(() => {
      const notice = ${JSON.stringify(payload)};
      const container = document.getElementById('hold-notice');
      const hint = document.getElementById('hold-hint');
      const progress = document.getElementById('hold-progress');
      if (!container || !hint || !progress) return;
      cancelAnimationFrame(window.holdQuitFrame);
      container.hidden = notice.phase === 'dismissed';
      hint.textContent = notice.hint;
      progress.hidden = notice.phase !== 'holding';
      progress.setAttribute('aria-label', notice.hint);
      progress.value = 0;
      if (notice.phase === 'holding') {
        const started = performance.now();
        const tick = () => {
          progress.value = Math.min(100, (performance.now() - started) / notice.duration * 100);
          if (progress.value < 100) window.holdQuitFrame = requestAnimationFrame(tick);
        };
        window.holdQuitFrame = requestAnimationFrame(tick);
      }
    })()`)
      .catch(() => {})
  }
  const ready = (): void => {
    loaded = true
    render()
  }
  bar.once('did-finish-load', ready)
  return {
    notice: (notice: HoldQuitNotice): void => {
      if (disposed) {
        return
      }
      latest = notice
      activeChanged(notice.phase !== 'dismissed')
      render()
    },
    dispose: (): void => {
      disposed = true
      bar.off('did-finish-load', ready)
    }
  }
}

export function attachPopupBarQuitNotice(options: {
  window: BaseWindow
  contents: WebContents
  bar: WebContents
  layout: (height: number) => void
}): void {
  const presenter = createPresenter(options.bar, (active) =>
    options.layout(POPUP_ORIGIN_BAR_HEIGHT + (active ? QUIT_NOTICE_HEIGHT : 0))
  )
  const surface = { window: options.window, notice: presenter.notice }
  const unregister = [options.contents, options.bar].map((contents) =>
    registerNativePopupQuitSurface(contents, surface)
  )
  options.window.once('closed', () => {
    presenter.dispose()
    for (const remove of unregister) {
      remove()
    }
  })
}

export function attachNativePopupQuitNotice(
  window: BrowserWindow,
  contents: WebContents
): {
  refreshOrigin: () => void
} {
  let view: WebContentsView | null = null
  let presenter: ReturnType<typeof createPresenter> | null = null
  let unregisterBar: (() => void) | null = null
  let closed = false
  const layout = (): void => {
    if (!view || window.isDestroyed()) {
      return
    }
    const bounds = window.getContentBounds()
    const width = Math.min(bounds.width, 440)
    const height = POPUP_ORIGIN_BAR_HEIGHT + QUIT_NOTICE_HEIGHT
    view.setBounds({
      x: bounds.width - width,
      y: Math.max(0, bounds.height - height),
      width,
      height
    })
  }
  const refreshOrigin = (): void => {
    if (!view || view.webContents.isDestroyed()) {
      return
    }
    const { label, insecure } = describeCommittedPopupOrigin(contents)
    void view.webContents
      .executeJavaScript(
        `document.body.classList.toggle('insecure', ${insecure ? 'true' : 'false'});` +
          `document.getElementById('origin').textContent = ${JSON.stringify(label)};`
      )
      .catch(() => {})
  }
  const removeView = (): void => {
    presenter?.dispose()
    presenter = null
    unregisterBar?.()
    unregisterBar = null
    if (view) {
      if (!window.isDestroyed()) {
        window.contentView.removeChildView(view)
      }
      if (!view.webContents.isDestroyed()) {
        view.webContents.close()
      }
      view = null
    }
  }
  const surface: NativePopupQuitSurface = {
    window,
    notice: (notice) => {
      if (closed || window.isDestroyed() || contents.isDestroyed()) {
        return
      }
      if (notice.phase === 'dismissed') {
        removeView()
        return
      }
      if (!view) {
        view = new WebContentsView({
          webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
        })
        presenter = createPresenter(view.webContents, () => {})
        unregisterBar = registerNativePopupQuitSurface(view.webContents, surface)
        window.contentView.addChildView(view)
        layout()
        view.webContents.once('did-finish-load', refreshOrigin)
        void view.webContents
          .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(POPUP_ORIGIN_BAR_HTML)}`)
          .catch(() => {})
      }
      presenter?.notice(notice)
    }
  }
  const unregister = registerNativePopupQuitSurface(contents, surface)
  window.on('resize', layout)
  window.once('closed', () => {
    closed = true
    unregister()
    removeView()
    window.off('resize', layout)
  })
  return { refreshOrigin }
}
