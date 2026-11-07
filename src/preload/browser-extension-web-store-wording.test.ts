// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { adaptChromeWebStoreWordingForOrca } from './browser-extension-web-store-wording'

const flushMutations = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  document.body.innerHTML = ''
})

describe('adaptChromeWebStoreWordingForOrca', () => {
  it('renames the install wording but keeps the store name', () => {
    document.body.innerHTML =
      '<a>Chrome Web Store</a><button aria-label="Add to Chrome"><span>Add to Chrome</span></button>'
    adaptChromeWebStoreWordingForOrca()
    expect(document.querySelector('a')?.textContent).toBe('Chrome Web Store')
    expect(document.querySelector('button')?.getAttribute('aria-label')).toBe('Add to Orca')
    expect(document.querySelector('span')?.textContent).toBe('Add to Orca')
  })

  it('renames wording the store draws later, including the removal toast', async () => {
    adaptChromeWebStoreWordingForOrca()
    const button = document.createElement('span')
    button.textContent = 'Remove from Chrome'
    document.body.appendChild(button)
    const toast = document.createElement('div')
    toast.textContent = 'Bitwarden has been removed from Chrome.'
    document.body.appendChild(toast)
    await flushMutations()
    expect(button.textContent).toBe('Remove from Orca')
    expect(toast.textContent).toBe('Bitwarden has been removed from Orca.')
    button.firstChild!.nodeValue = 'Add to Chrome'
    await flushMutations()
    expect(button.textContent).toBe('Add to Orca')
  })

  it('hides the switch-to-Chrome banner and shows the box again when the store reuses it', async () => {
    document.body.innerHTML =
      '<section><div id="banner"><div><div>Switch to Chrome to install extensions and themes</div></div><a>Install Chrome</a></div><h1>Vault</h1></section>'
    adaptChromeWebStoreWordingForOrca()
    const banner = document.getElementById('banner')!
    expect(banner.style.display).toBe('none')
    expect(document.querySelector('h1')?.textContent).toBe('Vault')
    banner.innerHTML = '<div>This item is disabled</div><a>Enable now</a>'
    await flushMutations()
    expect(banner.style.display).toBe('')
  })
})
