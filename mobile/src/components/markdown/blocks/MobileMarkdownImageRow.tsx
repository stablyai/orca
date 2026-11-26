import { createContext, useContext, type ReactNode } from 'react'
import { View } from 'react-native'
import { styles } from '../mobile-markdown-styles'

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
