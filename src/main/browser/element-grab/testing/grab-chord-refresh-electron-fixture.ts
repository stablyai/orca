import type { WebContents } from 'electron'
import { withAgentInputInjection } from '../../cdp/input/agent-input-injection'

export async function verifyGrabChordRefresh(
  page: WebContents,
  pages: string[],
  chord: (key?: string, shift?: boolean) => Promise<void>,
  updateBindings: () => void
) {
  updateBindings()
  await new Promise((resolve) => setTimeout(resolve, 80))
  const reset = async (): Promise<void> => {
    pages.length = 0
    await page.executeJavaScript(
      "document.getElementById('search').setSelectionRange(0,0);window.getSelection()?.removeAllRanges();document.getElementById('buy').focus();window.__pageKeys=[]"
    )
  }
  const read = async (key: string) => ({
    pages: [...pages],
    pageSawKey: await page.executeJavaScript(
      `window.__pageKeys.some(key=>key.toLowerCase()===${JSON.stringify(key)})`
    )
  })
  await reset()
  await chord('C')
  const oldChord = await read('c')
  await reset()
  await chord('G', true)
  const newChord = await read('g')
  await reset()
  await withAgentInputInjection(page, () => chord('G', true))
  const agentChord = await read('g')
  return { oldChord, newChord, agentChord }
}
