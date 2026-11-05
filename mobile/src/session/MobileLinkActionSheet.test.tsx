import { describe, expect, it, vi } from 'vitest'
import { act, create } from 'react-test-renderer'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { openExternalLink } from '../platform/external-link'
import { triggerError, triggerSuccess } from '../platform/haptics'
import { MobileLinkActionSheet } from './MobileLinkActionSheet'

const writeText = vi.fn<(text: string) => Promise<void>>()

vi.mock('../components/ActionSheetModal', () => ({ ActionSheetModal: 'ActionSheetModal' }))
vi.mock('../platform/external-link', () => ({ openExternalLink: vi.fn() }))
vi.mock('../platform/clipboard', () => ({ useClipboardWriter: () => ({ writeText }) }))
vi.mock('../platform/haptics', () => ({ triggerSuccess: vi.fn(), triggerError: vi.fn() }))

const URL = 'https://example.com/docs'

function sheetActions(openInOrca?: (url: string) => void) {
  let renderer!: ReturnType<typeof create>
  act(() => {
    renderer = create(<MobileLinkActionSheet url={URL} onClose={vi.fn()} openInOrca={openInOrca} />)
  })
  const actions: { id: string; onPress: () => void }[] =
    renderer.root.findByType(ActionSheetModal).props.actions
  return actions
}

describe('MobileLinkActionSheet', () => {
  it('hands the tapped URL to the Orca browser, the phone browser and the clipboard', async () => {
    const openInOrca = vi.fn()
    writeText.mockResolvedValueOnce()
    const actions = sheetActions(openInOrca)

    expect(actions.map((action) => action.id)).toEqual(['openInOrca', 'openInBrowser', 'copyLink'])
    actions[0]?.onPress()
    actions[1]?.onPress()
    await act(async () => actions[2]?.onPress())

    expect(openInOrca).toHaveBeenCalledWith(URL)
    expect(openExternalLink).toHaveBeenCalledWith(URL)
    expect(writeText).toHaveBeenCalledWith(URL)
    expect(triggerSuccess).toHaveBeenCalledTimes(1)
  })

  it("offers only the phone's choices where an Orca browser tab cannot open", () => {
    expect(sheetActions().map((action) => action.id)).toEqual(['openInBrowser', 'copyLink'])
  })

  it('does not claim a copy the clipboard refused', async () => {
    vi.mocked(triggerSuccess).mockClear()
    writeText.mockRejectedValueOnce(new Error('Clipboard unavailable'))
    const actions = sheetActions()

    await act(async () => actions.at(-1)?.onPress())

    expect(triggerError).toHaveBeenCalledTimes(1)
    expect(triggerSuccess).not.toHaveBeenCalled()
  })
})
