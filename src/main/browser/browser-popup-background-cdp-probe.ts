import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import { expect } from 'vitest'
import {
  artifactDir,
  browser,
  closeChildren,
  guest,
  origin,
  receipts,
  snapshots,
  status,
  type PopupFixtureReceipt
} from './browser-popup-compatibility-cdp-fixture'

export type BackgroundPopupProbe = {
  kind: 'link' | 'post' | 'empty' | 'multipart'
  context: 'same-origin' | 'cross-site' | 'no-referrer' | 'subframe' | 'opaque'
  input: 'middle' | 'modifier'
}

export const backgroundModifier = process.platform === 'darwin' ? 'Meta' : 'Control'

export async function refreshBackgroundPopupStatus(): Promise<void> {
  const before = status().revision
  await guest('route').evaluate('console.log("orca-popup-fixture:snapshot")')
  await expect.poll(() => status().revision).toBeGreaterThan(before)
}

export async function prepareBackgroundPopupProbe(
  page: Page,
  probe: BackgroundPopupProbe,
  destination: string
): Promise<void> {
  await page.evaluate(
    async ({ probe, destination }) => {
      document.querySelector('#background-probe')?.remove()
      document.querySelector('#background-gesture')?.remove()
      document
        .querySelector('meta[name=referrer]')
        ?.setAttribute(
          'content',
          probe.context === 'no-referrer' ? 'no-referrer' : 'strict-origin-when-cross-origin'
        )
      const container = document.createElement('div')
      container.id = 'background-probe'
      const link = document.createElement('a')
      link.id = 'background-open'
      link.href = destination
      link.textContent = 'Synthetic background link'
      const form = document.createElement('form')
      form.method = 'post'
      form.action = destination
      form.target = '_self'
      if (probe.kind === 'multipart') {
        form.enctype = 'multipart/form-data'
      }
      if (probe.kind !== 'empty') {
        const input = document.createElement('input')
        input.name = 'code'
        input.setAttribute('value', 'synthetic+value')
        form.append(input)
      }
      const button = document.createElement('button')
      button.id = 'background-open'
      button.textContent = 'Synthetic background POST'
      form.append(button)
      container.append(probe.kind === 'link' ? link : form)
      if (probe.context === 'subframe' || probe.context === 'opaque') {
        const frame = document.createElement('iframe')
        frame.id = container.id
        if (probe.context === 'opaque') {
          frame.setAttribute(
            'sandbox',
            'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox'
          )
        }
        frame.srcdoc = container.innerHTML
        const loaded = new Promise<void>((resolve) => {
          frame.addEventListener('load', () => resolve(), { once: true })
        })
        document.body.append(frame)
        await loaded
      } else {
        document.body.append(container)
      }
      const gesture = document.createElement('button')
      gesture.id = 'background-gesture'
      gesture.textContent = 'Synthetic route gesture'
      document.body.append(gesture)
    },
    { probe, destination }
  )
}

export async function clickBackgroundPopupProbe(
  page: Page,
  probe: BackgroundPopupProbe
): Promise<void> {
  const locator =
    probe.context === 'subframe' || probe.context === 'opaque'
      ? page.frameLocator('#background-probe').locator('#background-open')
      : page.locator('#background-open')
  if (probe.context === 'opaque') {
    // A hidden OOPIF can finish loading before browser input reaches its new frame.
    await locator.evaluate((element) => {
      element.removeAttribute('data-background-input-ready')
      element.addEventListener('pointermove', (event) => {
        if (event.isTrusted) {
          element.setAttribute('data-background-input-ready', 'true')
        }
      })
    })
    await page.locator('#background-gesture').click()
    await expect
      .poll(async () => {
        await locator.hover()
        return locator.getAttribute('data-background-input-ready')
      })
      .toBe('true')
    // Opaque frame input does not reach Electron's root route gesture gate.
    await page.locator('#background-gesture').click()
  }
  await locator.click(
    probe.input === 'middle' ? { button: 'middle' } : { modifiers: [backgroundModifier] }
  )
}

export async function observeBackgroundPopupProbe(
  name: 'local' | 'route',
  probe: BackgroundPopupProbe,
  control: boolean
): Promise<PopupFixtureReceipt | null> {
  const page = guest(control ? `${name}-control` : name)
  const targetOrigin =
    probe.context === 'same-origin' ? origin : origin.replace('127.0.0.1', 'localhost')
  const path = `/background-${name}-${probe.context}-${probe.kind}-${probe.input}-${control ? 'control' : 'production'}`
  const destination = `${targetOrigin}${path}`
  await prepareBackgroundPopupProbe(page, probe, destination)
  await refreshBackgroundPopupStatus()
  const before = receipts.length
  const requestsBefore = status().native.requests.length
  const tabsBefore = status().tabOpens.length
  await clickBackgroundPopupProbe(page, probe)
  await refreshBackgroundPopupStatus()
  await expect.poll(() => status().native.requests.length).toBeGreaterThan(requestsBefore)
  expect(status().native.requests.at(-1)).toEqual({
    disposition: 'background-tab',
    features: '',
    frameName: '',
    post: probe.kind !== 'link'
  })
  if (name === 'local' && probe.kind === 'link' && !control) {
    await expect.poll(() => status().tabOpens.length).toBe(tabsBefore + 1)
    expect(status().tabOpens.at(-1)).toEqual({ url: destination, activate: false })
    expect(receipts.slice(before).some((receipt) => receipt.path === path)).toBe(false)
    return null
  }
  await expect
    .poll(() => receipts.slice(before).some((receipt) => receipt.path === path))
    .toBe(true)
  await expect
    .poll(() =>
      browser
        ?.contexts()
        .flatMap((context) => context.pages())
        .some((candidate) => candidate.url() === destination)
    )
    .toBe(true)
  const child = browser
    ?.contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => candidate.url() === destination)
  if (!child) {
    throw new Error('Missing background native child')
  }
  if (!control) {
    await child.evaluate(() => {
      document.title = 'Hostile synthetic background title'
    })
    await refreshBackgroundPopupStatus()
    await expect.poll(() => status().native.windows.at(-1)?.title).toBe(targetOrigin)
    expect(status().native.windows.at(-1)).toMatchObject({ fullscreen: false, focused: false })
    if (name === 'route') {
      expect(status().native.creation.at(-1)).toMatchObject({
        firstNavigationPolicy: 'disable_non_proxied_udp',
        firstNavigationOwner: expect.any(Number),
        firstNavigationTitle: targetOrigin
      })
      expect(await child.evaluate('window.open("about:blank")===null')).toBe(true)
    }
  }
  expect(await child.evaluate('Notification.requestPermission()')).toBe('denied')
  expect(status().windowsHidden).toBe(true)
  expect(status().native.presentationCalls).toEqual([])
  if (artifactDir && !control && probe.kind === 'post' && probe.context === 'same-origin') {
    mkdirSync(artifactDir, { recursive: true })
    await child.screenshot({ path: join(artifactDir, `${name}-hidden-background-post.png`) })
  }
  snapshots.push(status())
  const receipt = receipts.slice(before).find((receipt) => receipt.path === path)
  if (!receipt) {
    throw new Error('Missing background receipt')
  }
  await closeChildren(page)
  return receipt
}

export function comparableBackgroundReceipt(receipt: PopupFixtureReceipt) {
  const { path: _path, ...request } = receipt
  return {
    ...request,
    referrer: request.referrer.replace('-control', ''),
    body: request.body.replace(/----WebKitFormBoundary\w+/g, '----synthetic-boundary'),
    contentType: request.contentType.replace(/; boundary=.*/, '')
  }
}
