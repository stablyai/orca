import { expect, it } from 'vitest'

const readStyling = (page) =>
  page.evaluate(() => {
    const editor = document.querySelector('#editor')
    return {
      scheme: document.getElementById('orca-rich-markdown-document-style').dataset.scheme,
      scoped: editor.parentElement.classList.contains('orca-rich-markdown-document-host'),
      taskListStyle: getComputedStyle(editor.querySelector('ul[data-type="taskList"]'))
        .listStyleType
    }
  })

async function setScheme(page, scheme) {
  await page.evaluate((next) => globalThis.__orcaEditor.setScheme(next), scheme)
  await page.waitForFunction(
    (next) => document.getElementById('orca-rich-markdown-document-style').dataset.scheme === next,
    scheme
  )
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  )
}

// React Native Web swaps the themed host View's className on a scheme change.
export function themeSwitchTest(getBrowser, openPage) {
  it('keeps a mounted editor styled through color scheme changes', async () => {
    const { page, consoleErrors } = await openPage(getBrowser())
    try {
      await setScheme(page, 'dark')
      await page.evaluate(() => globalThis.__orcaEditor.set({ content: '- [ ] Open task' }))
      await page.waitForSelector('#editor ul[data-type="taskList"]')
      for (const scheme of ['dark', 'light', 'dark']) {
        await setScheme(page, scheme)
        expect(await readStyling(page)).toEqual({ scheme, scoped: true, taskListStyle: 'none' })
      }
      expect(consoleErrors).toEqual([])
    } finally {
      await page.close()
    }
  }, 180_000)
}
