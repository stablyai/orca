import type { Page } from 'playwright'

export async function startHiddenRendererFrameCapture(
  page: Page,
  waitForFirstFrame: (hasFrame: () => boolean) => Promise<void>
): Promise<() => Promise<void>> {
  const cdp = await page.context().newCDPSession(page)
  let stopped = false
  const handlePageClose = (): void => {
    void stop().catch(() => {})
  }
  const stop = async (): Promise<void> => {
    if (stopped) {
      return
    }
    stopped = true
    try {
      await cdp.send('Page.stopScreencast')
    } finally {
      page.off('close', handlePageClose)
      cdp.off('Page.screencastFrame', acknowledgeFrame)
      await cdp.detach()
    }
  }
  let hasFrame = false
  const acknowledgeFrame = (frame: { sessionId: number }): void => {
    hasFrame = true
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {})
  }
  cdp.on('Page.screencastFrame', acknowledgeFrame)
  page.once('close', handlePageClose)
  try {
    // Keep hidden renderers painting without revealing their native windows.
    await cdp.send('Page.enable')
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 20,
      maxWidth: 640,
      maxHeight: 480
    })
    await waitForFirstFrame(() => hasFrame)
    return stop
  } catch (error) {
    await stop().catch(() => {})
    throw error
  }
}
