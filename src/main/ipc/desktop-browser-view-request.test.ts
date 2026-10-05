import { describe, expect, it } from 'vitest'
import {
  desktopBrowserViewCommandSchema,
  desktopBrowserViewCreateSchema,
  desktopBrowserViewIdentitySchema,
  desktopBrowserViewLayoutSchema
} from './desktop-browser-view-request'

const identity = { browserPageId: 'page', generation: 'main-minted-generation' }
const create = {
  browserPageId: 'page',
  workspaceId: 'workspace',
  worktreeId: 'folder:workspace',
  sessionProfileId: null,
  url: 'https://example.test/'
}
const layout = {
  ...identity,
  bounds: { x: 0, y: 40, width: 1152, height: 642 },
  visible: true,
  inputLocked: false
}

describe('desktop-owned browser request validation', () => {
  it('accepts page metadata without renderer-chosen native identities', () => {
    expect(desktopBrowserViewCreateSchema.parse(create)).toEqual(create)
    for (const field of ['webContentsId', 'partition', 'preload', 'ownerWindowId']) {
      expect(desktopBrowserViewCreateSchema.safeParse({ ...create, [field]: 7 }).success).toBe(
        false
      )
    }
  })

  it.each(['javascript:alert(1)', 'orca-preview://ungranted/doc', 'chrome://settings'])(
    'rejects an unsupported navigation target %s',
    (url) => {
      expect(desktopBrowserViewCreateSchema.safeParse({ ...create, url }).success).toBe(false)
      expect(
        desktopBrowserViewCommandSchema.safeParse({
          ...identity,
          command: { kind: 'navigate', url }
        }).success
      ).toBe(false)
    }
  )

  it('requires the current main-minted generation for subsequent commands', () => {
    expect(desktopBrowserViewIdentitySchema.safeParse({ browserPageId: 'page' }).success).toBe(
      false
    )
    expect(desktopBrowserViewIdentitySchema.parse(identity)).toEqual(identity)
  })

  it('rejects malformed bounds before reaching native view APIs', () => {
    expect(desktopBrowserViewLayoutSchema.parse(layout)).toEqual(layout)
    for (const width of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, 32769]) {
      expect(
        desktopBrowserViewLayoutSchema.safeParse({ ...layout, bounds: { ...layout.bounds, width } })
          .success
      ).toBe(false)
    }
  })

  it('does not provide arbitrary script execution or unbounded numeric commands', () => {
    expect(
      desktopBrowserViewCommandSchema.safeParse({
        ...identity,
        command: { kind: 'eval', code: '1' }
      }).success
    ).toBe(false)
    expect(
      desktopBrowserViewCommandSchema.safeParse({
        ...identity,
        command: { kind: 'zoom', level: Number.NaN }
      }).success
    ).toBe(false)
    expect(
      desktopBrowserViewCommandSchema.safeParse({
        ...identity,
        command: { kind: 'zoom', level: 99 }
      }).success
    ).toBe(false)
    expect(
      desktopBrowserViewCommandSchema.safeParse({
        ...identity,
        command: { kind: 'back', webContentsId: 9 }
      }).success
    ).toBe(false)
  })
})
