import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import type { RpcClient } from '../transport/rpc-client'
import { searchBaseRefs } from '../source-control/mobile-base-ref-search'

type Props = {
  client: RpcClient | null
  worktreeId: string
  value: string
  onChange: (ref: string) => void
  editable?: boolean
}

// Base-branch field for the create-PR composer: a free-text input that also searches
// repo refs (debounced) and offers matches to tap — the RN analogue of desktop's
// base-ref combobox. Free text stays valid so an SSH-only / unmatched ref can still
// be entered.
export function MobilePrBasePicker({
  client,
  worktreeId,
  value,
  onChange,
  editable = true
}: Props) {
  const [results, setResults] = useState<string[]>([])
  const [focused, setFocused] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Guards: drop results after unmount, and ignore an earlier search whose response
  // arrives after a later one (out-of-order network) so stale matches can't clobber.
  const mounted = useRef(true)
  const seq = useRef(0)

  useEffect(() => {
    return () => {
      mounted.current = false
      if (timer.current) {
        clearTimeout(timer.current)
      }
    }
  }, [])

  const queryRefs = useCallback(
    (query: string) => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
      if (!client || query.trim().length === 0) {
        setResults([])
        return
      }
      timer.current = setTimeout(() => {
        const requestSeq = ++seq.current
        void searchBaseRefs(client, worktreeId, query.trim())
          .then((refs) => {
            if (!mounted.current || requestSeq !== seq.current) {
              return
            }
            setResults(refs.filter((r) => r !== query).slice(0, 6))
          })
          // Why: a rejected ref search must not escape as an unhandled rejection;
          // drop to an empty result set (free text stays valid to submit).
          .catch(() => {
            if (mounted.current && requestSeq === seq.current) {
              setResults([])
            }
          })
      }, 200)
    },
    [client, worktreeId]
  )

  return (
    <View>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={(text) => {
          onChange(text)
          queryRefs(text)
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder="main"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        editable={editable}
      />
      {focused && results.length > 0 ? (
        <View style={styles.results}>
          {results.map((ref) => (
            <Pressable
              key={ref}
              style={({ pressed }) => [styles.resultRow, pressed && styles.resultRowPressed]}
              onPress={() => {
                onChange(ref)
                setResults([])
              }}
            >
              <Text style={styles.resultText} numberOfLines={1}>
                {ref}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.input,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.textPrimary,
    fontSize: typography.bodySize
  },
  results: {
    marginTop: spacing.xs,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderSubtle,
    borderRadius: radii.input,
    backgroundColor: colors.bgPanel,
    overflow: 'hidden'
  },
  resultRow: {
    minHeight: 40,
    justifyContent: 'center',
    paddingHorizontal: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.borderSubtle
  },
  resultRowPressed: { backgroundColor: colors.bgRaised },
  resultText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontFamily: typography.monoFamily
  }
})
