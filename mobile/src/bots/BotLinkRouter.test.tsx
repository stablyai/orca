import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, onTestFinished, vi } from 'vitest'
import { BotLinkRouter } from './BotLinkRouter'
import { clearBotLink, publishBotLink, readPendingBotLink } from './pending-bot-link'

type Picker = { onSelect: (value: string) => void; onAfterClose: () => void }
const view: {
  picker: Picker | null
  fallBack: (() => void) | null
  openHome: ReturnType<typeof vi.fn>
} = vi.hoisted(() => ({ picker: null, fallBack: null, openHome: vi.fn() }))
vi.mock('react-native', () => ({ Alert: { alert: vi.fn() } }))
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../new-workspace/NewWorkspaceLoadingDrawer', () => ({
  NewWorkspaceLoadingDrawer: () => null
}))
vi.mock('../components/sheets/PickerModal', () => ({
  PickerModal: (props: Picker) => {
    view.picker = props
    return null
  }
}))
vi.mock('./use-open-bot-home', () => ({
  useOpenBotHome: () => view.openHome,
  botPlaceClient: vi.fn()
}))
vi.mock('./BotSessionLinkResolver', () => ({
  BotSessionLinkResolver: ({ onFallBack }: { onFallBack: () => void }) => {
    view.fallBack = onFallBack
    return null
  }
}))
vi.mock('./use-bot-link-host-answers', () => {
  const bots = { kind: 'bots', bots: [{ id: 'bot', name: 'Bot', folderWorkspaceId: 'home' }] }
  const computer = (id: string) => ({
    key: `${id}\nlocal`,
    pairedHostId: id,
    executionHost: 'local',
    answer: bots
  })
  const answers = {
    hosts: [
      { id: 'owner', name: 'Owner' },
      { id: 'other', name: 'Other' }
    ],
    answers: [
      { hostId: 'owner\nlocal', answer: bots },
      { hostId: 'other\nlocal', answer: bots }
    ],
    computers: new Map([
      ['owner\nlocal', computer('owner')],
      ['other\nlocal', computer('other')]
    ]),
    clientFor: () => null,
    failed: false
  }
  return { useBotLinkHostAnswers: () => answers }
})

it('looks up a thread on the computer picked for it instead of opening the bot Home', async () => {
  const conversation = { source: 'slack' as const, externalId: 'C:1' }
  publishBotLink({ kind: 'session', botId: 'bot', conversation })
  const { id } = readPendingBotLink()!
  onTestFinished(() => clearBotLink(id))
  let tree: ReturnType<typeof create> | undefined
  await act(async () => {
    tree = create(createElement(BotLinkRouter))
  })
  onTestFinished(() => act(async () => tree?.unmount()))

  await act(async () => view.fallBack?.())
  await act(async () => {
    view.picker?.onSelect('owner\nlocal')
    view.picker?.onAfterClose()
  })

  expect(readPendingBotLink()).toEqual({
    id,
    target: { kind: 'session', botId: 'bot', conversation, hostKey: 'owner\nlocal' }
  })
  expect(view.openHome).not.toHaveBeenCalled()
})

it('ignores a picker that closes after a newer link arrived', async () => {
  publishBotLink({ kind: 'bot', botId: 'bot' })
  const { id } = readPendingBotLink()!
  onTestFinished(() => clearBotLink(id))
  let tree: ReturnType<typeof create> | undefined
  await act(async () => {
    tree = create(createElement(BotLinkRouter))
  })
  onTestFinished(() => act(async () => tree?.unmount()))
  const stale = view.picker
  stale?.onSelect('owner\nlocal')

  publishBotLink({ kind: 'bot', botId: 'newer' })
  const newer = readPendingBotLink()!
  onTestFinished(() => clearBotLink(newer.id))
  stale?.onAfterClose()

  expect(view.openHome).not.toHaveBeenCalled()
  expect(readPendingBotLink()).toBe(newer)
})
