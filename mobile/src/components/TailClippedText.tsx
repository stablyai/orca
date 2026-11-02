import type { ReactNode } from 'react'
import { StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native'

// One line that keeps the end of `children` in view, cut from the left (the page ignores ellipsizeMode="head"); `after` follows it and is cut on the right.
export function TailClippedText({
  style,
  children,
  after
}: {
  style: StyleProp<TextStyle>
  children: ReactNode
  after?: ReactNode
}) {
  return (
    <View style={styles.frame}>
      <View style={styles.tail}>
        <Text style={[style, styles.line]}>{children}</Text>
      </View>
      {after ? <Text style={[style, styles.line]}>{after}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  frame: {
    flexDirection: 'row',
    overflow: 'hidden'
  },
  // As wide as its line up to the frame; flex-end pushes a longer line's start off the left edge.
  tail: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    overflow: 'hidden',
    maxWidth: '100%',
    flexShrink: 0
  },
  line: {
    flexShrink: 0
  }
})
