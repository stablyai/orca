// Who can ask › Add people: the desktop's BotWhoCanAskPicker as a page. Tick people found in one
// connector's workspace, then add them together; whoever can already ask stays listed, greyed.
import { useEffect, useState } from 'react'
import { BOT_MAX_MEMBERS, type BotMember } from '../../../src/shared/bot-types'
import { MobileSearchField } from '../components/controls/MobileSearchField'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { ListGroup, ListRow, SectionHeader } from '../components/list/ListGroup'
import { SheetHeader } from '../components/nav-bar/SheetHeader'
import { SheetPrimaryButton } from '../components/sheets/SheetPrimaryButton'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { SettingsNote } from '../settings/settings-screen-frame'
import type { WhoCanAskConnector, WhoCanAskFound } from './who-can-ask-connectors'

const SEARCH_DEBOUNCE_MS = 250

type Search =
  | { status: 'loading' }
  | { status: 'ready'; found: WhoCanAskFound }
  | { status: 'failed'; error: string }

type Found = WhoCanAskFound['members'][number]

function useMemberSearch(
  connector: WhoCanAskConnector,
  query: string,
  idle: boolean
): { search: Search; retry: () => void } {
  const [search, setSearch] = useState<Search>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const { search: find, errorMessage } = connector
  useEffect(() => {
    if (!find || idle) {
      return
    }
    let current = true
    setSearch({ status: 'loading' })
    const timer = setTimeout(() => {
      void find(query.trim()).then((result) => {
        if (current) {
          setSearch(
            result.ok
              ? { status: 'ready', found: result.value }
              : { status: 'failed', error: errorMessage(result.error) }
          )
        }
      })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(timer)
    }
    // Keyed by connector, not its search: a route read rebuilds that without changing what it finds.
  }, [connector.key, query, attempt, idle])
  return { search, retry: () => setAttempt((count) => count + 1) }
}

const matches = (name: string, needle: string): boolean =>
  needle === '' || name.toLowerCase().includes(needle)

// Saved as the desktop saves it: a found person's picture is kept, their handle isn't.
const asMember = (found: Found, connector: WhoCanAskConnector): BotMember => ({
  id: found.id,
  name: found.name,
  ...(found.avatarUrl ? { avatarUrl: found.avatarUrl } : {}),
  ...connector.stamp
})

const NoMatch = ({ title, detail }: { title: string; detail: string }) => (
  <MobileStateView title={title} message={detail} />
)

export function MobileBotWhoCanAskPicker(props: {
  connector: WhoCanAskConnector
  /** Everyone who can ask the agent, on every connector. */
  members: readonly BotMember[]
  /** Kept from a Give access the owner backed out of. */
  initialPicked: BotMember[]
  onCancel: () => void
  onPicked: (picked: BotMember[]) => void
}) {
  const t = useMobileTranslation()
  const { connector } = props
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<BotMember[]>(props.initialPicked)
  const needle = query.trim().toLowerCase()
  const idle = needle === '' ? connector.idleHint : undefined
  const { search, retry } = useMemberSearch(connector, query, idle !== undefined)
  const listed = connector.listed
  const added = new Set(listed.map((member) => member.id))
  const full =
    props.members.length + picked.length >= BOT_MAX_MEMBERS ||
    added.size + picked.length >= connector.max
  const isPicked = (id: string): boolean => picked.some((entry) => entry.id === id)
  const toggle = (member: BotMember): void =>
    setPicked((current) =>
      isPicked(member.id) ? current.filter((entry) => entry.id !== member.id) : [...current, member]
    )

  const found = search.status === 'ready' && !idle ? search.found.members : []
  const handles = new Map(found.map((person) => [person.id, person.handle]))
  const isOwner = (id: string): boolean => connector.ownerIds.includes(id)
  const addable = found.filter((person) => !added.has(person.id) && !isOwner(person.id))
  const withAccess = listed.filter(
    (member) => matches(member.name || member.id, needle) || found.some((p) => p.id === member.id)
  )
  const ownerShown = needle === '' || found.some((person) => isOwner(person.id))
  const handleLine = (name: string, handle: string | undefined) =>
    handle && handle !== name ? handle : undefined

  const pickRow = (member: BotMember, handle?: string) => {
    const on = isPicked(member.id)
    return (
      <ListRow
        key={member.id}
        title={member.name || member.id}
        subtitle={handleLine(member.name, handle)}
        selected={on}
        accessibilityRole="checkbox"
        disabled={full && !on}
        onPress={() => toggle(member)}
      />
    )
  }
  // Ticked people the current search no longer shows stay on top, so what's added is on screen.
  const offScreen = picked.filter((member) => !addable.some((person) => person.id === member.id))
  const canAsk = t('bots.whoCanAsk.canAsk', 'Can ask')

  const people = idle ? (
    <MobileStateView title={idle.title} message={idle.detail} />
  ) : search.status === 'failed' ? (
    <MobileStateView
      title={search.error}
      action={{ label: t('bots.whoCanAsk.retry', 'Try again'), onPress: retry }}
    />
  ) : search.status === 'loading' ? (
    <MobileStateView loading title={t('bots.whoCanAsk.searching', 'Searching…')} />
  ) : addable.length > 0 ? (
    <>
      <SectionHeader title={connector.peopleHeading} />
      <ListGroup>
        {addable.map((person) =>
          pickRow(asMember(person, connector), handleLine(person.name, person.handle))
        )}
      </ListGroup>
    </>
  ) : withAccess.length === 0 && !ownerShown ? (
    <NoMatch {...connector.noMatch(query.trim())} />
  ) : null

  return (
    <>
      <SheetHeader
        title={t('bots.whoCanAsk.addPeople', 'Add people')}
        subtitle={connector.title}
        leading={{ label: t('bots.whoCanAsk.cancel', 'Cancel'), onPress: props.onCancel }}
      />
      <MobileSearchField
        value={query}
        onChangeText={setQuery}
        placeholder={connector.searchPlaceholder}
        autoFocus
      />
      {offScreen.length > 0 ? (
        <>
          <SectionHeader title={t('bots.whoCanAsk.selectedHeading', 'Selected')} />
          <ListGroup>{offScreen.map((member) => pickRow(member))}</ListGroup>
        </>
      ) : null}
      {people}
      {withAccess.length > 0 || ownerShown ? (
        <>
          <SectionHeader title={canAsk} />
          <ListGroup>
            {ownerShown ? (
              <ListRow
                title={t('bots.whoCanAsk.you', 'You')}
                subtitle={t('bots.whoCanAsk.owner', 'Owner')}
                value={canAsk}
                disabled
              />
            ) : null}
            {withAccess.map((member) => (
              <ListRow
                key={member.id}
                title={member.name || member.id}
                subtitle={handleLine(member.name, handles.get(member.id))}
                value={canAsk}
                disabled
              />
            ))}
          </ListGroup>
        </>
      ) : null}
      <SettingsNote>
        {t('bots.whoCanAsk.addedCount', '{{count}} of {{max}} added', {
          count: added.size + picked.length,
          max: connector.max
        })}
        {search.status === 'ready' && !idle && !search.found.complete
          ? ` ${t(
              'bots.whoCanAsk.incomplete',
              'Not everyone is listed. Search by name to find someone.'
            )}`
          : ''}
      </SettingsNote>
      {picked.length > 0 ? (
        <>
          <SettingsNote>
            {t('bots.whoCanAsk.selected', '{{count}} selected', { count: picked.length })}
          </SettingsNote>
          <SheetPrimaryButton
            label={
              picked.length === 1
                ? t('bots.whoCanAsk.addOne', 'Add 1 person')
                : t('bots.whoCanAsk.addMany', 'Add {{count}} people', { count: picked.length })
            }
            onPress={() => props.onPicked(picked)}
          />
        </>
      ) : null}
    </>
  )
}
