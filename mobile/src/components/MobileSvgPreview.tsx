import { useMemo, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { readSvgIntrinsicSize, svgMarkupDataUri } from '../../../src/shared/svg-document'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { MobileLoadErrorState } from './MobileStateView'
import { MobilePanZoomImage } from './MobilePanZoomImage'
import { MobilePreviewSourceTabs, type MobilePreviewMode } from './MobilePreviewSourceTabs'

type Props = {
  markup: string
  title: string
  // Rendered when the user flips to "Source" (the existing syntax view).
  renderSource: () => React.ReactNode
  /** Shown above the drawing, e.g. a save failure the Source view would otherwise only show. */
  notice?: React.ReactNode
}

export function MobileSvgPreview({ markup, title, renderSource, notice }: Props) {
  const t = useMobileTranslation()
  const [mode, setMode] = useState<MobilePreviewMode>('preview')
  const uri = useMemo(() => svgMarkupDataUri(markup), [markup])
  const size = useMemo(() => readSvgIntrinsicSize(markup), [markup])
  // Key the failure by source so an edited file retries without an effect reset.
  const [failedUri, setFailedUri] = useState<string | null>(null)

  const preview =
    failedUri === uri ? (
      <MobileLoadErrorState
        error={t('components.svgPreview.drawFailed', 'Unable to draw this SVG')}
      />
    ) : (
      <MobilePanZoomImage
        uri={uri}
        size={size}
        upscale
        label={t('components.svgPreview.label', '{{title}} drawing', { title })}
        onError={() => setFailedUri(uri)}
      />
    )
  return (
    <View style={styles.container}>
      <MobilePreviewSourceTabs
        mode={mode}
        onModeChange={setMode}
        previewLabel={t('components.svgPreview.previewDrawing', 'Preview drawing')}
        sourceLabel={t('components.svgPreview.viewSource', 'View SVG source')}
      />
      {mode === 'preview' ? (
        <>
          {notice}
          {preview}
        </>
      ) : (
        renderSource()
      )}
    </View>
  )
}

const styles = StyleSheet.create({ container: { flex: 1 } })
