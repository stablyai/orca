// FlatList (native and web) honours `strictMode` at runtime; React Native's bundled types omit it.
declare module 'react-native' {
  interface FlatListProps<ItemT> {
    /** Memoizes the item renderer so a cell re-renders only when its item or `renderItem` changes. */
    strictMode?: boolean
  }
}

export {}
