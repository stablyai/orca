import { useEffect, useState } from 'react'
import { Text, View } from 'react-native'
import { Search } from 'lucide-react-native'
import { colors } from '../../theme/mobile-theme'
import { useMobileColorScheme } from '../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../i18n/use-mobile-translation'
import { searchMobilePrBaseRefs } from '../../source-control/mobile-pr-create-draft'
import { SheetHeader } from '../nav-bar/SheetHeader'
import { ListGroup, ListRow } from '../list/ListGroup'
import { TextField } from '../composer-input/TextField'
import type { MobilePrTab } from './use-mobile-pr-tab'
import { prSheetStyles as sheetStyles } from './pr-tab-styles'

// The Create PR sheet's base picker: desktop's ref search, as branch names.
export function PrBasePicker({
  tab,
  current,
  onPick,
  onBack
}: {
  tab: MobilePrTab
  current: string
  onPick: (base: string) => void
  onBack: () => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const { client, worktreeId } = tab
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const trimmed = query.trim()
    if (!client || !trimmed) {
      setResults(null)
      return
    }
    let stale = false
    // Same debounce as desktop's base search.
    const timer = setTimeout(() => {
      void searchMobilePrBaseRefs(client, worktreeId, trimmed)
        .then((refs) => {
          if (!stale) {
            setResults(refs)
            setFailed(false)
          }
        })
        .catch(() => {
          if (!stale) {
            setResults([])
            setFailed(true)
          }
        })
    }, 200)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [client, query, worktreeId])

  const options = results ?? [current]
  return (
    <View>
      <SheetHeader
        title={t('pullRequest.createSheet.base', 'Base')}
        leading={{ label: t('common.back', 'Back'), onPress: onBack }}
      />
      <View style={sheetStyles.body}>
        <TextField
          leading={<Search size={16} color={colors.textMuted} />}
          value={query}
          onChangeText={setQuery}
          placeholder={t('pullRequest.createSheet.searchBranches', 'Search branches')}
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus
        />
        {failed ? (
          <Text style={sheetStyles.error}>
            {t('pullRequest.createSheet.branchSearchFailed', 'Branch search failed.')}
          </Text>
        ) : options.length === 0 ? (
          <Text style={sheetStyles.note}>
            {t('pullRequest.createSheet.noBranches', 'No matching branches')}
          </Text>
        ) : (
          <ListGroup>
            {options.map((ref) => (
              <ListRow
                key={ref}
                title={ref}
                selected={ref === current}
                onPress={() => onPick(ref)}
              />
            ))}
          </ListGroup>
        )}
      </View>
    </View>
  )
}
