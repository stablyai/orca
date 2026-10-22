import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  findNodeHandle,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ScrollView
} from 'react-native'
import { colors, radii, spacing, typography } from '../theme/mobile-theme'
import { subscribeSoftKeyboard } from '../platform/keyboard-occlusion'
import {
  deleteEndpointAuthHeaders,
  readEndpointAuthHeaders,
  writeEndpointAuthHeaders
} from '../transport/endpoint-auth-headers-store'
import {
  normalizeEndpointAuthHeaders,
  type EndpointAuthHeaders
} from '../transport/endpoint-auth-headers'

export type EdgeAuthRow = { id: string; name: string; value: string }

/** The only scroller capability the section needs — narrow so tests can stub it. */
export type EdgeAuthScrollTarget = Pick<ScrollView, 'scrollResponderScrollNativeHandleToKeyboard'>

let nextRowId = 0

export function newEdgeAuthRow(): EdgeAuthRow {
  nextRowId += 1
  return { id: `edge-auth-${nextRowId}`, name: '', value: '' }
}

export function useEdgeAuthHeaders() {
  const [authRows, setAuthRows] = useState<EdgeAuthRow[]>(() => [newEdgeAuthRow()])
  // Match normalized blank rows so loading never creates a phantom credential change.
  const [initialAuthJson, setInitialAuthJson] = useState(() =>
    JSON.stringify({ ok: true, headers: {} })
  )
  const [storedAuthCount, setStoredAuthCount] = useState(0)
  const authNormalized = useMemo(() => normalizeEndpointAuthHeaders(authRows), [authRows])
  const authChanged = authNormalized.ok && JSON.stringify(authNormalized) !== initialAuthJson

  const loadAuthForHost = useCallback(
    async (hostId: string, endpoint: string, isCurrent?: () => boolean) => {
      const stored = await readEndpointAuthHeaders(hostId, endpoint)
      if (isCurrent && !isCurrent()) {
        return
      }
      const entries = stored ? Object.entries(stored) : []
      const rows =
        entries.length > 0
          ? entries.map(([headerName, headerValue]) => ({
              ...newEdgeAuthRow(),
              name: headerName,
              value: headerValue
            }))
          : [newEdgeAuthRow()]
      setAuthRows(rows)
      setInitialAuthJson(JSON.stringify(normalizeEndpointAuthHeaders(rows)))
      setStoredAuthCount(entries.length)
    },
    []
  )

  const persistAuthChanges = useCallback(
    async (hostId: string, headers: EndpointAuthHeaders, endpoint: string) => {
      // Why: auth rows normalize blank to {}; an empty save clears rather than storing nothing.
      if (Object.keys(headers).length === 0) {
        await deleteEndpointAuthHeaders(hostId)
      } else {
        await writeEndpointAuthHeaders(hostId, headers, endpoint)
      }
    },
    []
  )

  return {
    authRows,
    setAuthRows,
    authNormalized,
    authChanged,
    storedAuthCount,
    loadAuthForHost,
    persistAuthChanges
  }
}

export function EdgeAuthHeadersSection({
  rows,
  storedCount,
  error,
  onRowsChange,
  scrollViewRef,
  hint
}: {
  rows: EdgeAuthRow[]
  storedCount: number
  hint?: string
  error: string | null
  onRowsChange: (rows: EdgeAuthRow[]) => void
  scrollViewRef: { current: EdgeAuthScrollTarget | null }
}) {
  const focusedRowId = useRef<string | null>(null)
  const rowRefs = useRef(new Map<string, View>())
  const scrollFocusedRowIntoView = useCallback(() => {
    const row = focusedRowId.current ? rowRefs.current.get(focusedRowId.current) : undefined
    const scroller = scrollViewRef.current
    if (!row || !scroller) {
      return
    }
    const handle = findNodeHandle(row)
    if (typeof handle !== 'number') {
      return
    }
    scroller.scrollResponderScrollNativeHandleToKeyboard(handle, spacing.md, true)
  }, [scrollViewRef])
  useEffect(
    () =>
      // Keep focused credentials above the soft keyboard.
      subscribeSoftKeyboard(
        () => scrollFocusedRowIntoView(),
        () => {
          focusedRowId.current = null
        }
      ),
    [scrollFocusedRowIntoView]
  )
  const focusRow = useCallback(
    (id: string) => {
      focusedRowId.current = id
      // Moving between fields may not emit another keyboard-show event.
      scrollFocusedRowIntoView()
    },
    [scrollFocusedRowIntoView]
  )
  return (
    <View>
      <Text style={styles.label}>Edge authentication</Text>
      <Text style={styles.hint}>
        {hint ??
          "Optional headers for secure tunnels, stored in this phone's keychain and never in pairing links. If the secure host or port changes, save the address, then reopen this form to enter credentials for it. Leave all rows blank for none."}
        {storedCount > 0 ? ` ${storedCount} header${storedCount === 1 ? '' : 's'} saved.` : ''}
      </Text>
      {rows.map((row, index) => (
        <View
          key={row.id}
          ref={(element) => {
            if (element) {
              rowRefs.current.set(row.id, element)
            } else {
              rowRefs.current.delete(row.id)
            }
          }}
          style={styles.authRow}
        >
          <TextInput
            style={[styles.input, styles.authName]}
            accessibilityLabel={`Header ${index + 1} name`}
            value={row.name}
            onFocus={() => focusRow(row.id)}
            onChangeText={(value) =>
              onRowsChange(rows.map((r) => (r.id === row.id ? { ...r, name: value } : r)))
            }
            placeholder="CF-Access-Client-Id"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
          />
          <TextInput
            style={[styles.input, styles.authValue]}
            accessibilityLabel={`Header ${index + 1} value`}
            value={row.value}
            onFocus={() => focusRow(row.id)}
            onChangeText={(value) =>
              onRowsChange(rows.map((r) => (r.id === row.id ? { ...r, value } : r)))
            }
            placeholder="Secret value"
            placeholderTextColor={colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            secureTextEntry
          />
          <Pressable
            style={styles.authRemove}
            onPress={() =>
              onRowsChange(
                rows.length > 1 ? rows.filter((r) => r.id !== row.id) : [newEdgeAuthRow()]
              )
            }
            accessibilityRole="button"
            accessibilityLabel={`Remove header ${index + 1}`}
          >
            <Text style={styles.authRemoveText}>✕</Text>
          </Pressable>
        </View>
      ))}
      <Pressable
        style={styles.secondaryButton}
        onPress={() => onRowsChange([...rows, newEdgeAuthRow()])}
        accessibilityRole="button"
        accessibilityLabel="Add header"
      >
        <Text style={styles.secondaryButtonText}>Add header</Text>
      </Pressable>
      {error ? <Text style={styles.previewError}>{error}</Text> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  label: {
    color: colors.textSecondary,
    fontSize: typography.metaSize,
    fontWeight: '500',
    marginTop: spacing.sm,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  hint: {
    color: colors.textMuted,
    fontSize: typography.metaSize,
    lineHeight: 16
  },
  input: {
    backgroundColor: colors.bgPanel,
    borderWidth: 1,
    borderColor: colors.borderSubtle,
    borderRadius: radii.row,
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    paddingHorizontal: spacing.md,
    paddingVertical: Platform.OS === 'ios' ? 12 : 10
  },
  authRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'center'
  },
  authName: {
    flex: 5
  },
  authValue: {
    flex: 6
  },
  authRemove: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center'
  },
  authRemoveText: {
    color: colors.textMuted,
    fontSize: typography.bodySize
  },
  secondaryButton: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radii.button,
    backgroundColor: colors.bgRaised
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontSize: typography.bodySize,
    fontWeight: '500'
  },
  previewError: {
    marginTop: spacing.sm,
    color: colors.statusRed,
    fontSize: typography.bodySize
  }
})
