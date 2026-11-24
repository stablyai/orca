import { useState } from 'react'
import { View } from 'react-native'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { PickerModal } from '../components/sheets/PickerModal'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useCommanderDetailBack } from './commander-detail-back'
import { MemoryButton, s } from './phone-memory-controls'

export type HandoffFilter = { q?: string; projectId?: string }

export function PhoneHandoffSearch({
  active,
  busy,
  projects,
  allProjects,
  projectId,
  queryText,
  setQueryText,
  apply
}: {
  active: boolean
  busy: boolean
  projects: string[]
  allProjects: string
  projectId?: string
  queryText: string
  setQueryText: (text: string) => void
  apply: (filter: HandoffFilter) => void
}) {
  const t = useMobileTranslation()
  const [picking, setPicking] = useState(false)
  const projectLabel = t('commander.memoryProject', 'Project')
  const searchLabel = t('commander.handoffSearch', 'Search handoffs')
  useCommanderDetailBack(active && picking ? () => setPicking(false) : null)
  function submit(query: string, project: string | undefined) {
    const q = query.trim()
    apply({ ...(q ? { q } : {}), ...(project ? { projectId: project } : {}) })
  }
  return (
    <>
      <MobileSearchField
        value={queryText}
        onChangeText={(text) => setQueryText(text.slice(0, 512))}
        editable={!busy}
        placeholder={searchLabel}
        accessibilityLabel={searchLabel}
        onSubmitEditing={() => submit(queryText, projectId)}
        showClear={!busy && queryText.length > 0}
        onClear={() => {
          setQueryText('')
          submit('', projectId)
        }}
      />
      <View style={s.row}>
        <MemoryButton
          label={searchLabel}
          disabled={busy}
          onPress={() => submit(queryText, projectId)}
        />
        <MemoryButton
          label={projectLabel + ' · ' + (projectId ?? allProjects)}
          disabled={busy || !projects.length}
          onPress={() => setPicking(true)}
        />
      </View>
      <PickerModal
        visible={active && picking}
        title={projectLabel}
        searchable
        options={[
          { value: '', label: allProjects },
          ...projects.map((value) => ({ value, label: value }))
        ]}
        selected={projectId ?? ''}
        onSelect={(value) => submit(queryText, value)}
        onClose={() => setPicking(false)}
      />
    </>
  )
}
