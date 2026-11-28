// The bot picture picker as fixtures frame it: a sample bot, upload and image-agent stubs, New bot and
// Settings around the picker, and the steps that walk it to its Generate face.
import { useEffect, useState } from 'react'
import { stubBots } from './fixture-bots'
import type { BotShareReview } from '../../../shared/bots/bot-share-received'
import type { Bot } from '../../../shared/bot-types'
import type {
  AvatarGenerationApi,
  AvatarGenerationCapability
} from '../../../shared/avatar-generation/avatar-generation-contract'
import { useBotPictureSetting } from '@/components/settings/bots/use-bot-picture-setting'
import { BotPictureButton } from '@/components/bots/BotPictureButton'
import { NewBotDialog } from '@/components/bots/NewBotDialog'
import { resetAvatarRequestsForTests } from '@/components/bots/avatar-generation-requests'
import { refreshAvatarCapability } from '@/components/bots/avatar-generation-capability-store'

export const perf: Bot = {
  id: 'perf',
  name: 'Perf Manager',
  hostId: 'local',
  folder: 'perf',
  folderWorkspaceId: 'fw-perf',
  agent: 'claude',
  avatar: 'mascot:D1',
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: { appId: 'A1', teamId: 'T1' },
  linear: null,
  github: null,
  chatSessionId: null,
  createdAt: 1,
  updatedAt: 1
}

// Original art drawn here: a cat face on a warm gradient, `size` px square.
export async function artPng(size = 512): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const c = canvas.getContext('2d')!
  const s = size / 512
  const g = c.createLinearGradient(0, 0, size, size)
  g.addColorStop(0, '#ffd8a8')
  g.addColorStop(1, '#ff8f6b')
  c.fillStyle = g
  c.fillRect(0, 0, size, size)
  c.fillStyle = '#2b2d42'
  c.beginPath()
  c.arc(256 * s, 300 * s, 150 * s, 0, Math.PI * 2)
  c.moveTo(140 * s, 210 * s)
  c.lineTo(170 * s, 90 * s)
  c.lineTo(230 * s, 170 * s)
  c.moveTo(372 * s, 210 * s)
  c.lineTo(342 * s, 90 * s)
  c.lineTo(282 * s, 170 * s)
  c.fill()
  c.fillStyle = '#fff'
  for (const x of [205, 307]) {
    c.beginPath()
    c.arc(x * s, 290 * s, 26 * s, 0, Math.PI * 2)
    c.fill()
  }
  const blob = await new Promise<Blob>((resolve) => canvas.toBlob((b) => resolve(b!), 'image/png'))
  return new File([blob], 'cat.png', { type: 'image/png' })
}

const NO_IMAGE_AGENTS: AvatarGenerationApi = {
  capability: async () => ({ agents: [] }),
  generate: async () => ({ ok: false, error: 'unavailable' }),
  cancel: async () => {}
}

/** Answers uploads without a runtime, with these image agents; the capability cache outlives a
 *  fixture, so it is read again from them. */
export function stubUpload(generation: AvatarGenerationApi = NO_IMAGE_AGENTS): void {
  Reflect.set(window.api, 'avatarGeneration', generation)
  refreshAvatarCapability()
  stubBots([perf])
  const runtime = window.api.runtime
  const call = runtime.call
  Reflect.set(window.api, 'runtime', {
    ...runtime,
    call: async (request: Parameters<typeof call>[0]) => {
      if (request.method === 'bots.avatar.read') {
        return { ok: true, result: { png: null, revision: perf.avatarRevision ?? 0 } }
      }
      if (request.method === 'bots.avatar.upload') {
        return { ok: true, result: { bot: { ...perf, avatar: 'upload:fixture' } } }
      }
      return call(request)
    }
  })
}

export const settle = (ms = 350): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export function dialog(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="dialog"]')!
}

export async function paste(file: File): Promise<void> {
  const transfer = new DataTransfer()
  transfer.items.add(file)
  dialog().dispatchEvent(
    new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
  )
  await settle()
}

export async function dragOver(): Promise<void> {
  const transfer = new DataTransfer()
  transfer.items.add(new File(['x'], 'cat.png', { type: 'image/png' }))
  dialog().dispatchEvent(
    new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true })
  )
  await settle()
}

export function NewBot(): React.JSX.Element {
  return (
    <div className="h-[640px]">
      <NewBotDialog
        open
        onOpenChange={() => {}}
        initialName="Perf Manager"
        proposal={{ name: 'Perf Manager', purpose: '', mascot: 'D1' }}
      />
    </div>
  )
}

// Settings > Picture as the settings root draws it (that view's imports don't load in fixtures).
export function SettingsPicture(): React.JSX.Element {
  const picture = useBotPictureSetting(perf, async () => perf)
  return (
    <BotPictureButton
      bot={perf}
      picture={picture}
      avatarClassName="size-12 rounded-lg text-xl"
      className="rounded-lg"
    />
  )
}

export function Settings(): React.JSX.Element {
  return (
    <div className="flex h-[380px] items-start gap-4 p-6">
      <SettingsPicture />
      <div className="pt-3 text-lg font-semibold">{perf.name}</div>
    </div>
  )
}

export const openPicture = async (frame: HTMLElement): Promise<void> => {
  frame.querySelector<HTMLButtonElement>('button[aria-label="Edit bot picture"]')?.click()
  await settle()
}

export async function artBase64(): Promise<string> {
  const bytes = new Uint8Array(await (await artPng()).arrayBuffer())
  let binary = ''
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

/** A local image agent that answers as `result` says, or never (still running); `late` fails after a
 *  second, once the fixture has left the picker. */
export function stubGeneration(
  capability: AvatarGenerationCapability,
  result: 'image' | 'running' | 'usage-limit' | 'no-image' | 'late-failure' | 'late-image'
): () => void {
  return () => {
    // Fixtures share one page: a run left going by the one before would show here.
    resetAvatarRequestsForTests()
    const api: AvatarGenerationApi = {
      capability: async () => capability,
      generate: async () => {
        if (result === 'running') {
          return new Promise(() => {})
        }
        if (result === 'usage-limit' || result === 'no-image') {
          return { ok: false, error: result, agent: 'codex' }
        }
        if (result === 'late-failure') {
          await settle(2500)
          return { ok: false, error: 'timed-out', agent: 'codex' }
        }
        if (result === 'late-image') {
          await settle(1200)
        }
        return {
          ok: true,
          agent: 'codex',
          image: { mimeType: 'image/png', base64: await artBase64() }
        }
      },
      cancel: async () => {}
    }
    stubUpload(api)
  }
}

export function carousel(): HTMLElement {
  return document.querySelector<HTMLElement>('[aria-roledescription="carousel"]')!
}

export async function step(key: 'ArrowLeft' | 'ArrowRight'): Promise<void> {
  carousel().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  await settle(80)
}

/** The description field, once Generate is the current face and the field has folded open. */
export function shownField(): HTMLTextAreaElement | null {
  const box = document.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Picture description"]'
  )
  return box && !box.closest('[aria-hidden="true"]') ? box : null
}

// The Generate face sits just before mascot 1: step left until its description field shows.
export async function openGenerate(
  frame: HTMLElement,
  description?: string,
  { submit = true }: { submit?: boolean } = {}
): Promise<void> {
  await openPicture(frame)
  for (let tries = 0; tries < 25 && !shownField(); tries += 1) {
    await step('ArrowLeft')
  }
  // The rows cross-fade over 300 ms.
  await settle(400)
  if (description === undefined) {
    return
  }
  const box = shownField()!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
    box,
    description
  )
  box.dispatchEvent(new Event('input', { bubbles: true }))
  await settle(100)
  if (!submit) {
    return
  }
  document.querySelector<HTMLButtonElement>('button[aria-label="Generate"]')?.click()
  await settle(600)
}

export const READY: AvatarGenerationCapability = {
  agents: [
    { agent: 'codex', status: 'ready' },
    { agent: 'grok', status: 'ready' }
  ]
}

export async function openGenerateAgainBox(): Promise<void> {
  document.querySelector<HTMLButtonElement>('button[aria-label="Edit description"]')?.click()
  await settle(400)
}

/** No image agent until Check again finds Codex (as if just installed); then its runs fail once,
 *  make a picture, and from the third on run until canceled. */
export function stubGeneratorAfterRecheck(): void {
  resetAvatarRequestsForTests()
  let found = false
  let runs = 0
  stubUpload({
    capability: async (options) => {
      found ||= options?.fresh === true
      await settle(300)
      return found ? { agents: [{ agent: 'codex', status: 'ready' }] } : { agents: [] }
    },
    generate: async () => {
      runs += 1
      if (runs > 2) {
        return new Promise(() => {})
      }
      await settle(800)
      return runs === 1
        ? { ok: false, error: 'failed', agent: 'codex' }
        : { ok: true, agent: 'codex', image: { mimeType: 'image/png', base64: await artBase64() } }
    },
    cancel: async () => {}
  })
}

/** Codex installed but signed out until Check again (as if signed in meanwhile), then ready. */
export function stubSignedOutUntilRecheck(): void {
  resetAvatarRequestsForTests()
  let signedIn = false
  stubUpload({
    capability: async (options) => {
      signedIn ||= options?.fresh === true
      await settle(300)
      return { agents: [{ agent: 'codex', status: signedIn ? 'ready' : 'signed-out' }] }
    },
    generate: async () => ({
      ok: true,
      agent: 'codex',
      image: { mimeType: 'image/png', base64: await artBase64() }
    }),
    cancel: async () => {}
  })
}

/** The first check finds Codex ready; later quiet checks answer the same, but slowly, while a run
 *  finds it signed out in the meantime: the older answer must not bring Generate back. */
export function stubStaleProbe(): void {
  resetAvatarRequestsForTests()
  let calls = 0
  stubUpload({
    capability: async (options) => {
      calls += 1
      if (calls > 1 && options?.fresh !== true) {
        await settle(6000)
      }
      return { agents: [{ agent: 'codex', status: 'ready' }] }
    },
    generate: async () => ({ ok: false, error: 'signed-out', agent: 'codex' }),
    cancel: async () => {}
  })
}

/** The first capability check never answers. */
export function stubGeneratorChecking(): void {
  resetAvatarRequestsForTests()
  stubUpload({
    capability: () => new Promise(() => {}),
    generate: async () => ({ ok: false, error: 'unavailable' }),
    cancel: async () => {}
  })
}

/** New bot from a shared link whose bot has its own picture (as the review gives it), once drawn. */
export function NewBotFromSharedLink(): React.JSX.Element | null {
  const [png, setPng] = useState<string | null>(null)
  useEffect(() => {
    void artBase64().then(setPng)
  }, [])
  if (!png) {
    return null
  }
  const review: BotShareReview = {
    reviewId: 'review-fixture',
    shareId: 'share-fixture',
    versionId: 'v1',
    publisher: null,
    publishedAt: '2026-11-27T00:00:00.000Z',
    bot: {
      schemaVersion: 1,
      name: 'Perf Manager',
      avatar: { image: 'avatar.png' },
      purpose: '',
      agentHint: 'claude',
      skills: [],
      tools: [],
      connectors: [],
      schedules: [],
      eventSuggestions: [],
      memory: []
    },
    files: [],
    flags: [],
    leftOut: [],
    avatarDataUrl: `data:image/png;base64,${png}`
  }
  return (
    <div className="h-[640px]">
      <NewBotDialog
        open
        onOpenChange={() => {}}
        fromShare={{ review, toolIds: [], onBack: () => {}, onMoved: () => {} }}
      />
    </div>
  )
}
