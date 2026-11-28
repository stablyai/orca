import { createContext, useContext, type ReactNode } from 'react'
import { StyleSheet, View } from 'react-native'
import { spacing } from '../../../theme/mobile-theme'

export const MarkdownImageLayout = createContext<'blocks' | 'document' | 'row'>('blocks')

export function MobileMarkdownImageRow({ children }: { children: ReactNode }) {
  const layout = useContext(MarkdownImageLayout)
  return layout === 'blocks' ? (
    children
  ) : (
    <MarkdownImageLayout.Provider value="row">
      <View style={styles.imageRow}>{children}</View>
    </MarkdownImageLayout.Provider>
  )
}

const styles = StyleSheet.create({
  imageRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    alignItems: 'center',
    gap: spacing.xs
  }
})
