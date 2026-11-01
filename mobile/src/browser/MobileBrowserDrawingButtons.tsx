import { Maximize2, Minimize2, MonitorUp, Server, Smartphone } from 'lucide-react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import type { MobileBrowserDrawing } from '../storage/preferences'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { buttonColor } from './mobile-browser-frame-state'
import { MobileBrowserToolbarIconButton } from './MobileBrowserToolbarIconButton'

export type MobileBrowserFullScreenToggle = { active: boolean; onToggle: () => void }

// What a streamed tab offers when the phone can also draw it.
export type MobileBrowserStreamedDrawing = {
  onDrawingChange: (drawing: MobileBrowserDrawing) => void
  fullScreen: MobileBrowserFullScreenToggle | null
}

type Props = {
  drawing: MobileBrowserDrawing
  onDrawingChange: (drawing: MobileBrowserDrawing) => void
  fullScreen: MobileBrowserFullScreenToggle | null
}

function drawingColor(active: boolean): string {
  return active ? colors.accentBlue : buttonColor(true)
}

/** How the tab is drawn, and full screen: the same buttons whether the tab streams or the phone draws it. */
export function MobileBrowserDrawingButtons({
  drawing,
  onDrawingChange,
  fullScreen
}: Props): React.JSX.Element {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const pick = (next: MobileBrowserDrawing) => () => {
    if (next !== drawing) {
      onDrawingChange(next)
    }
  }
  return (
    <>
      <MobileBrowserToolbarIconButton
        label={t('browser.localPane.streamFromHost', 'Stream from the host instead')}
        onPress={pick('stream')}
      >
        <MonitorUp size={15} color={drawingColor(drawing === 'stream')} />
      </MobileBrowserToolbarIconButton>
      <MobileBrowserToolbarIconButton
        label={t('browser.localPane.throughHost', 'Connect through the host')}
        onPress={pick('host')}
      >
        <Server size={15} color={drawingColor(drawing === 'host')} />
      </MobileBrowserToolbarIconButton>
      <MobileBrowserToolbarIconButton
        label={t('browser.localPane.phoneNetwork', "Connect on the phone's network")}
        onPress={pick('phone')}
      >
        <Smartphone size={15} color={drawingColor(drawing === 'phone')} />
      </MobileBrowserToolbarIconButton>
      {fullScreen && (
        <MobileBrowserToolbarIconButton
          label={
            fullScreen.active
              ? t('browser.localPane.leaveFullScreen', 'Leave full screen')
              : t('browser.localPane.fullScreen', 'Full screen')
          }
          onPress={fullScreen.onToggle}
        >
          {fullScreen.active ? (
            <Minimize2 size={15} color={buttonColor(true)} />
          ) : (
            <Maximize2 size={15} color={buttonColor(true)} />
          )}
        </MobileBrowserToolbarIconButton>
      )}
    </>
  )
}
