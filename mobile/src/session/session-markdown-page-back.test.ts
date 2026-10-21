import { createElement, type SetStateAction } from 'react'
import { act, create } from 'react-test-renderer'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import {
  createPageBackConsumers,
  type PageBackConsumers
} from '../mobile-web-shell/bridge/page-back-consumers'

/** The page's Back stack and what it told the shell, as `use-back-claim.web.test.tsx` builds it. */
type PageBackProbe = {
  claims: boolean[]
  unclaimed: Mock
  consumers: PageBackConsumers | null
}

const page = vi.hoisted((): PageBackProbe => ({ claims: [], unclaimed: vi.fn(), consumers: null }))
const native = vi.hoisted(() => ({ dismiss: vi.fn(), addEventListener: vi.fn() }))

vi.mock('react-native', () => ({
  BackHandler: { addEventListener: native.addEventListener },
  Keyboard: { dismiss: () => native.dismiss() },
  Platform: { OS: 'web' }
}))
// The bundler resolves the page's sibling here; vitest resolves the native file unless told.
vi.mock('../navigation/use-back-claim', () => import('../navigation/use-back-claim.web'))
vi.mock('../transport/client-context.web', () => ({
  usePageBridgeClientIfPresent: () => ({
    claimBack: (claim: () => boolean) => stack().claim(claim)
  })
}))
vi.mock('../platform/clipboard', () => ({
  useClipboardWriter: () => ({ writeText: async () => {} })
}))
vi.mock('../platform/haptics', () => ({ triggerSuccess: () => {}, triggerError: () => {} }))
vi.mock('./mobile-session-write-operations', () => ({ markdownTabSave: () => ({}) }))

import {
  useMobileSessionMarkdownActions,
  type MobileSessionMarkdownActionsScope
} from './use-mobile-session-markdown-actions'
import type { DirtyMarkdownDraft, MarkdownDocState } from './mobile-session-route-types'

function stack(): PageBackConsumers {
  if (page.consumers === null) {
    throw new Error('the page back stack was not built for this case')
  }
  return page.consumers
}

const router = { canGoBack: vi.fn(() => true), back: vi.fn(), replace: vi.fn() }
const setLeaveDrafts: Mock<(drafts: SetStateAction<DirtyMarkdownDraft[] | null>) => void> = vi.fn()

function scopeWith(markdownDocs: Map<string, MarkdownDocState>): MobileSessionMarkdownActionsScope {
  return {
    hostId: 'host-1',
    worktreeId: 'wt-1',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook calls only canGoBack/back/replace; any other member is a TypeError here.
    router: router as unknown as MobileSessionMarkdownActionsScope['router'],
    client: null,
    sessionTabs: [],
    markdownDocs,
    setMarkdownDocs: () => {},
    discardMarkdownTarget: null,
    setDiscardMarkdownTarget: () => {},
    setLeaveDrafts,
    markdownSaveSeqRef: { current: new Map() },
    markdownSaveInFlightRef: { current: new Set() },
    showToast: () => {},
    readMarkdownTab: async () => {}
  }
}

function readyDoc(content: string, localContent: string): MarkdownDocState {
  return {
    status: 'ready',
    content,
    localContent,
    baseVersion: 'v1',
    isDirty: content !== localContent,
    editable: true
  }
}

function Probe({ docs }: { docs: Map<string, MarkdownDocState> }): null {
  useMobileSessionMarkdownActions(scopeWith(docs))
  return null
}

function render(docs: Map<string, MarkdownDocState>): ReturnType<typeof create> {
  let renderer: ReturnType<typeof create> | null = null
  act(() => {
    renderer = create(createElement(Probe, { docs }))
  })
  if (renderer === null) {
    throw new Error('the probe did not render')
  }
  return renderer
}

beforeEach(() => {
  page.claims.length = 0
  page.unclaimed.mockClear()
  page.consumers = createPageBackConsumers({
    publishClaim: (claimed) => page.claims.push(claimed),
    onUnclaimed: page.unclaimed
  })
  native.dismiss.mockClear()
  native.addEventListener.mockClear()
  router.back.mockClear()
  router.replace.mockClear()
  setLeaveDrafts.mockClear()
})

/**
 * Inside the shell's page an unclaimed Back is the shell's own pop, so an unsaved Markdown draft
 * has to hold the key or it is dropped without the prompt.
 */
describe("the session's Back on the page", () => {
  it('claims the key while a draft is dirty, and a press opens the unsaved-drafts prompt', () => {
    render(new Map([['tab-1', readyDoc('saved', 'edited')]]))
    expect(page.claims).toEqual([true])
    act(() => stack().press())
    expect(page.unclaimed).not.toHaveBeenCalled()
    expect(native.dismiss).toHaveBeenCalledTimes(1)
    expect(setLeaveDrafts).toHaveBeenCalledWith([
      { tabId: 'tab-1', title: 'Markdown', content: 'edited' }
    ])
    expect(router.back).not.toHaveBeenCalled()
  })

  it('claims nothing while every draft is clean, so the press stays the shell pop', () => {
    render(new Map([['tab-1', readyDoc('saved', 'saved')]]))
    expect(page.claims).toEqual([])
    act(() => stack().press())
    expect(page.unclaimed).toHaveBeenCalledTimes(1)
    expect(setLeaveDrafts).not.toHaveBeenCalled()
  })

  it('takes the key when a draft goes dirty and lets it go when the draft is saved', () => {
    const renderer = render(new Map())
    act(() => {
      renderer.update(
        createElement(Probe, { docs: new Map([['tab-1', readyDoc('saved', 'edited')]]) })
      )
    })
    act(() => {
      renderer.update(
        createElement(Probe, { docs: new Map([['tab-1', readyDoc('edited', 'edited')]]) })
      )
    })
    expect(page.claims).toEqual([true, false])
  })

  it('never reaches for the native key', () => {
    render(new Map([['tab-1', readyDoc('saved', 'edited')]]))
    expect(native.addEventListener).not.toHaveBeenCalled()
  })
})
