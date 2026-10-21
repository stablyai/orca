import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { StyleSheet, View } from 'react-native'

const DetailCardHostContext = createContext<HTMLElement | null>(null)

export function DetailCardHostProvider({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(null)
  const attach = useCallback((node: unknown) => {
    setHost(node instanceof HTMLElement ? node : null)
  }, [])
  return (
    <DetailCardHostContext.Provider value={host}>
      <View style={styles.root}>
        {children}
        <View ref={attach} pointerEvents="box-none" style={styles.outlet} />
      </View>
    </DetailCardHostContext.Provider>
  )
}

export function DetailCardLayer({ children }: { children: ReactNode }) {
  const host = useContext(DetailCardHostContext)
  return host ? createPortal(children, host) : null
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  outlet: { ...StyleSheet.absoluteFillObject, zIndex: 1000 }
})

export function commitDetailCardExit(settle: () => void) {
  flushSync(settle)
}
