import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  ScrollView,
  StyleSheet,
  Text,
  type HostInstance,
  type StyleProp,
  type TextStyle
} from 'react-native'
import {
  loadMobileMathTypesetter,
  type MobileMathTypesetter
} from './mobile-markdown-math-typesetter'

let loaded: MobileMathTypesetter | null = null
let loading: Promise<MobileMathTypesetter | null> | null = null

function useMathTypesetter(): MobileMathTypesetter | null {
  const [typesetter, setTypesetter] = useState<MobileMathTypesetter | null>(() => loaded)
  useEffect(() => {
    if (typesetter) {
      return
    }
    let disposed = false
    // A failed chunk load leaves the source showing; the next formula to mount tries again.
    loading ??= loadMobileMathTypesetter().then(
      (ready) => (loaded = ready),
      () => {
        loading = null
        return null
      }
    )
    void loading.then((ready) => {
      if (!disposed) {
        setTypesetter(() => ready)
      }
    })
    return () => {
      disposed = true
    }
  }, [typesetter])
  return typesetter
}

type MobileMarkdownMathProps = {
  value: string
  /** Shown until KaTeX loads, and instead of a formula KaTeX can't parse, as on desktop. */
  source: string
  display: boolean
  /** GitHub text: large sizes drawn as github.com draws them (the PR line-count table). */
  githubSizes: boolean
  style?: StyleProp<TextStyle>
}

/** A formula typeset by KaTeX into the page's DOM; react-native-web renders Text as a span. */
export const MobileMarkdownMath = memo(function MobileMarkdownMath({
  value,
  source,
  display,
  githubSizes,
  style
}: MobileMarkdownMathProps) {
  const typesetter = useMathTypesetter()
  const html = useMemo(
    () => typesetter?.(value, display, githubSizes) ?? null,
    [typesetter, value, display, githubSizes]
  )
  const hostRef = useRef<HostInstance>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    if (html === null || !(host instanceof HTMLElement)) {
      return
    }
    host.innerHTML = html
    // Copying a selection reads the formula back as this source (markdownMathSelectionText).
    host.dataset.mathSource = source
    return () => {
      host.replaceChildren()
      delete host.dataset.mathSource
    }
  }, [html, source])

  if (html === null) {
    return <Text style={style}>{source}</Text>
  }
  // React owns the empty host; KaTeX's markup inside it is written by the effect above.
  const host = <Text key="typeset" ref={hostRef} style={style} />
  return display ? (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.display}
    >
      {host}
    </ScrollView>
  ) : (
    host
  )
})

const styles = StyleSheet.create({
  display: { flexGrow: 1, justifyContent: 'center' }
})
