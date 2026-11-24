import {
  Menu,
  type BrowserWindow,
  type MenuItemConstructorOptions,
  type WebContents
} from 'electron'

type EditableContextMenuPopup = {
  open: (template: MenuItemConstructorOptions[], point: { x: number; y: number }) => void
  close: () => void
}

type Retirement = { retired: boolean }
type OpenMenu = { menu: Menu; retirement: Retirement }

// macOS closePopup is posted asynchronously, so a click can still land after retirement.
function retirableTemplate(
  template: MenuItemConstructorOptions[],
  retirement: Retirement
): MenuItemConstructorOptions[] {
  return template.map((item) => {
    const { click, submenu } = item
    return {
      ...item,
      ...(click
        ? {
            click: (...args: Parameters<typeof click>) => {
              if (!retirement.retired) {
                click(...args)
              }
            }
          }
        : {}),
      ...(Array.isArray(submenu) ? { submenu: retirableTemplate(submenu, retirement) } : {})
    }
  })
}

export function createEditableContextMenuPopup(
  window: BrowserWindow,
  webContents: Pick<WebContents, 'on'>
): EditableContextMenuPopup {
  let current: OpenMenu | null = null
  const close = (): void => {
    const opened = current
    current = null
    if (opened) {
      opened.retirement.retired = true
      opened.menu.closePopup()
    }
  }
  // A menu opened while a reload is pending belongs to the old document; retire it at commit.
  webContents.on('did-frame-navigate', (_event, _url, _code, _status, isMainFrame) => {
    if (isMainFrame) {
      close()
    }
  })

  return {
    open: (template, point) => {
      close()
      const retirement: Retirement = { retired: false }
      const menu = Menu.buildFromTemplate(retirableTemplate(template, retirement))
      const opened: OpenMenu = { menu, retirement }
      current = opened
      menu.popup({
        window,
        x: point.x,
        y: point.y,
        callback: () => {
          if (current === opened) {
            current = null
          }
        }
      })
    },
    close
  }
}
