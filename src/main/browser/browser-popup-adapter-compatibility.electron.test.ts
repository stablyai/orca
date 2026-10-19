import { describe, expect, it } from 'vitest'
import type { Page } from 'playwright'
import {
  browser,
  closeChildren,
  enablePopupAdapterProbe,
  expectedSecurity,
  guest,
  origin,
  receipts,
  setPopupFixtureEvidenceName,
  snapshots,
  status
} from './browser-popup-compatibility-cdp-fixture'

enablePopupAdapterProbe()
setPopupFixtureEvidenceName('adapter-electron-evidence.json')

type CreationPath = 'adopted' | 'native'
const creationPaths = ['adopted', 'native'] as const

function eventsSince(offset: number): Record<string, unknown>[] {
  return status().adapterProbe?.slice(offset) ?? []
}

async function childAt(url: string): Promise<Page> {
  await expect
    .poll(() =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .some((candidate) => candidate.url() === url)
    )
    .toBe(true)
  const child = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url() === url)
  if (!child) {
    throw new Error('Missing probe child')
  }
  return child
}

async function configure(page: Page, path: CreationPath): Promise<void> {
  await page.evaluate((path) => console.log(`orca-popup-fixture:probe-${path}`), path)
}

async function installBurst(page: Page, count = 3): Promise<void> {
  await page.evaluate((count) => {
    document.querySelector('#identity-burst')?.remove()
    const button = document.createElement('button')
    button.id = 'identity-burst'
    button.onclick = () => {
      for (let index = 0; index < count; index++) {
        const child = window.open('/identical-child')
        if (child) {
          child.name = `original-request-${index}`
        }
      }
    }
    document.body.append(button)
  }, count)
}

function assertObservedCreationOrder(events: Record<string, unknown>[], path: CreationPath): void {
  const delivered = events.filter(
    (event) => event.event === (path === 'adopted' ? 'createWindow' : 'did-create-window')
  )
  const admitted = events.filter((event) => event.event === 'admission')
  expect(delivered.length).toBe(admitted.length)
  for (const [index, event] of delivered.entries()) {
    expect(event.owner).toBe(admitted[index].owner)
    expect(event.preferences).toMatchObject(expectedSecurity)
    if (path === 'adopted') {
      expect(event.callbackRequest).toBe(admitted[index].request)
    } else {
      expect(event.optionsArguments).toEqual([
        `--orca-popup-probe=${String(admitted[index].request)}`
      ])
    }
    const first = events.findIndex(
      (candidate) =>
        candidate.event === 'did-start-navigation' && candidate.contentsId === event.contentsId
    )
    expect(first).toBeGreaterThan(events.indexOf(event))
    expect(
      events.find(
        (candidate) =>
          candidate.event === 'before-request' && candidate.contentsId === event.contentsId
      )
    ).toMatchObject({ observedBeforeRequest: true, webRtcPolicy: 'disable_non_proxied_udp' })
  }
}

describe('Electron popup adapter API limits (not an admission safety gate)', () => {
  it.each(creationPaths)(
    'records same-parent identical URLs with foreground, background and window intent: %s',
    async (path) => {
      expect(status().electronVersion).toBe('43.7.8')
      const page = guest('probe-one')
      await configure(page, path)
      for (const modifier of [null, 'Shift', 'ControlOrMeta'] as const) {
        const offset = status().adapterProbe?.length ?? 0
        const before = receipts.length
        await installBurst(page)
        await page.locator('#identity-burst').click(modifier ? { modifiers: [modifier] } : {})
        await expect
          .poll(
            () =>
              receipts.slice(before).filter((receipt) => receipt.path === '/identical-child').length
          )
          .toBe(3)
        await expect
          .poll(() => eventsSince(offset).filter((event) => event.event === 'loaded').length)
          .toBe(3)
        const events = eventsSince(offset)
        assertObservedCreationOrder(events, path)
        expect(
          events
            .filter((event) => event.event === 'loaded')
            .map((event) => event.frameName)
            .sort()
        ).toEqual(['original-request-0', 'original-request-1', 'original-request-2'])
        const dispositions = events
          .filter((event) => event.event === 'admission')
          .map((event) => event.details)
        expect(dispositions).toEqual(
          Array.from({ length: 3 }, () =>
            expect.objectContaining({
              disposition:
                modifier === 'Shift' ? 'new-window' : modifier ? 'background-tab' : 'foreground-tab'
            })
          )
        )
        snapshots.push(status())
        await closeChildren(page)
      }
    }
  )

  it.each(creationPaths)(
    'records two parents sharing a session with distinct simultaneous intent: %s',
    async (path) => {
      const pages = [guest('probe-one'), guest('probe-two')]
      for (const page of pages) {
        await configure(page, path)
        await installBurst(page, 1)
      }
      const offset = status().adapterProbe?.length ?? 0
      const before = receipts.length
      await Promise.all([
        pages[0].locator('#identity-burst').click({ modifiers: ['Shift'] }),
        pages[1].locator('#identity-burst').click({ modifiers: ['ControlOrMeta'] })
      ])
      await expect
        .poll(
          () =>
            receipts.slice(before).filter((receipt) => receipt.path === '/identical-child').length
        )
        .toBe(2)
      await expect
        .poll(() => eventsSince(offset).filter((event) => event.event === 'loaded').length)
        .toBe(2)
      const events = eventsSince(offset)
      const admitted = events.filter((event) => event.event === 'admission')
      expect(new Set(admitted.map((event) => event.owner)).size).toBe(2)
      // Each parent's delivery is observed independently; ordering across parents is not authority.
      for (const owner of admitted.map((event) => event.owner)) {
        assertObservedCreationOrder(
          events.filter((event) => event.owner === owner || !event.owner),
          path
        )
      }
      expect(
        receipts
          .slice(before)
          .filter((receipt) => receipt.path === '/identical-child')
          .every((receipt) => receipt.cookie === 'synthetic_session=local')
      ).toBe(true)
      snapshots.push(status())
      for (const page of pages) {
        await closeChildren(page)
      }
    }
  )

  it.each(creationPaths)(
    'records immediate close, then reopen without inferring cancellation from delivery order: %s',
    async (path) => {
      const page = guest('probe-one')
      await configure(page, path)
      const offset = status().adapterProbe?.length ?? 0
      await page.evaluate(() => {
        document.querySelector('#cancel-probe')?.remove()
        const button = document.createElement('button')
        button.id = 'cancel-probe'
        button.onclick = () => {
          window.open('/cancelled-child')?.close()
          const child = window.open('/reopened-child')
          if (child) {
            child.name = 'reopened-original'
          }
        }
        document.body.append(button)
      })
      await page.locator('#cancel-probe').click({ modifiers: ['Shift'] })
      const reopened = await childAt(`${origin}/reopened-child`)
      expect(await reopened.evaluate('window.name')).toBe('reopened-original')
      const events = eventsSince(offset)
      expect(events.filter((event) => event.event === 'admission')).toHaveLength(2)
      expect(
        events.filter(
          (event) => event.event === (path === 'adopted' ? 'createWindow' : 'did-create-window')
        )
      ).toHaveLength(2)
      // Both creation callbacks precede the renderer's close(); this is not a missing-callback cancellation.
      snapshots.push(status())
      await closeChildren(page)
    }
  )

  it.each(creationPaths)(
    'cannot distinguish inherited script restrictions synchronously: %s',
    async (path) => {
      const records = await exerciseSandboxControls(path, 'script')
      expect(records[0].preferences).toEqual(records[1].preferences)
      expect(records[0].frameOrigin).toBe(records[1].frameOrigin)
      if (path === 'adopted') {
        expect(withoutRequestMarker(records[0].optionsPreferences)).toEqual(
          withoutRequestMarker(records[1].optionsPreferences)
        )
      }
    }
  )

  it.each(creationPaths)(
    'exposes inherited flags on native OpenURL link options only: %s',
    async (path) => {
      const records = await exerciseSandboxControls(path, 'link')
      const preferences = records.map((record) => record.optionsPreferences)
      expect(preferences[0]).toHaveProperty('openerSandboxFlags', expect.any(Number))
      expect(preferences[1]).not.toHaveProperty('openerSandboxFlags')
      expect(preferences[2]).not.toHaveProperty('openerSandboxFlags')
      if (path === 'adopted') {
        expect(records.every((record) => record.event === 'createWindow-missing')).toBe(true)
      }
    }
  )

  it('records baseline early tab dispatch for the restricted script with zero original-child requests', async () => {
    const page = guest('local')
    const before = receipts.length
    const tabs = status().tabOpens.length
    await installSandboxFrame(page, 'restricted', `${origin}/baseline-restricted`, 'script')
    await page.frameLocator('#sandbox-probe').locator('#open').click()
    await expect.poll(() => status().tabOpens.length).toBe(tabs + 1)
    expect(status().tabOpens.at(-1)).toEqual({
      url: `${origin}/baseline-restricted`,
      activate: true
    })
    expect(receipts.slice(before).some((receipt) => receipt.path === '/baseline-restricted')).toBe(
      false
    )
    snapshots.push(status())
  })

  it('reproduces production native admission attaching to an unrelated same-session app window', async () => {
    const page = guest('probe-two')
    await page.evaluate('console.log("orca-popup-fixture:probe-unrelated")')
    await installBurst(page, 1)
    const offset = status().adapterProbe?.length ?? 0
    await page.locator('#identity-burst').click({ modifiers: ['Shift'] })
    await childAt(`${origin}/identical-child`)
    const events = eventsSince(offset)
    const unrelated = events.find((event) => event.event === 'unrelated-window')
    const admitted = events.find((event) => event.event === 'production-adapter-created')
    expect(unrelated).toBeDefined()
    expect(admitted?.contentsId).toBe(unrelated?.contentsId)
    expect(events.filter((event) => event.event === 'production-adapter-created')).toHaveLength(1)
    const realChild = events.find((event) => event.event === 'did-create-window')
    expect(realChild?.contentsId).not.toBe(admitted?.contentsId)
    snapshots.push(status())
    await page.evaluate('console.log("orca-popup-fixture:probe-cleanup")')
    await closeChildren(page)
  })
})

function withoutRequestMarker(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !['additionalArguments', 'session'].includes(key))
  )
}

async function installSandboxFrame(
  page: Page,
  sandbox: string,
  destination: string,
  kind: string
): Promise<void> {
  await page.evaluate(
    ({ sandbox, destination, kind }) => {
      document.querySelector('#sandbox-probe')?.remove()
      const frame = document.createElement('iframe')
      frame.id = 'sandbox-probe'
      if (sandbox !== 'unsandboxed') {
        frame.setAttribute(
          'sandbox',
          `allow-scripts allow-popups${sandbox === 'escape' ? ' allow-popups-to-escape-sandbox' : ''}`
        )
      }
      frame.srcdoc =
        kind === 'script'
          ? `<button id="open" onclick="window.open('${destination}', '_blank', 'noopener')">Open</button>`
          : `<a id="open" href="${destination}" target="_blank" rel="noopener">Open</a>`
      document.body.append(frame)
    },
    { sandbox, destination, kind }
  )
}

async function exerciseSandboxControls(
  path: CreationPath,
  kind: 'script' | 'link'
): Promise<Record<string, unknown>[]> {
  const page = guest('probe-one')
  await configure(page, path)
  const records: Record<string, unknown>[] = []
  for (const sandbox of ['restricted', 'escape', 'unsandboxed']) {
    const destination = `${origin}/sandbox-${path}-${kind}-${sandbox}`
    const offset = status().adapterProbe?.length ?? 0
    await installSandboxFrame(page, sandbox, destination, kind)
    const initialReceipt = receipts.length
    await page
      .frameLocator('#sandbox-probe')
      .locator('#open')
      .click(kind === 'link' ? { modifiers: ['Shift'] } : {})
    if (path === 'adopted' && kind === 'link') {
      await expect
        .poll(() => eventsSince(offset).some((event) => event.event === 'createWindow-missing'))
        .toBe(true)
      const creation = eventsSince(offset).find((event) => event.event === 'createWindow-missing')
      if (!creation) {
        throw new Error('Missing OpenURL options')
      }
      records.push(creation)
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(
        receipts.slice(initialReceipt).some((receipt) => destination.endsWith(receipt.path))
      ).toBe(false)
      snapshots.push(status())
      await page.evaluate('console.log("orca-popup-fixture:probe-cleanup")')
      continue
    }
    const child = await childAt(destination)
    expect(await child.evaluate('window.opener === null')).toBe(true)
    const before = receipts.length
    await child.evaluate((action) => {
      const form = document.createElement('form')
      form.action = action
      form.method = 'POST'
      document.body.append(form)
      form.submit()
    }, `${origin}/sandbox-form-${path}-${kind}-${sandbox}`)
    if (sandbox === 'restricted') {
      await expect
        .poll(() => eventsSince(offset).some((event) => event.event === 'sandbox-form-blocked'))
        .toBe(true)
      expect(
        receipts.slice(before).some((receipt) => receipt.path.startsWith('/sandbox-form-'))
      ).toBe(false)
      expect(child.url()).toBe(destination)
    } else {
      await expect
        .poll(() =>
          receipts.slice(before).some((receipt) => receipt.path.startsWith('/sandbox-form-'))
        )
        .toBe(true)
    }
    await page.evaluate('console.log("orca-popup-fixture:snapshot")')
    const creation = eventsSince(offset).find(
      (event) =>
        event.event ===
        (path === 'adopted'
          ? kind === 'script'
            ? 'createWindow'
            : 'createWindow-missing'
          : 'did-create-window')
    )
    if (!creation) {
      throw new Error('Missing creation event')
    }
    records.push(creation)
    expect(status().windowsHidden).toBe(true)
    snapshots.push(status())
    await closeChildren(page)
  }
  return records
}
