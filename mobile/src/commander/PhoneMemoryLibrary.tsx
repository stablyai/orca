import { useCommanderDetailBack } from './commander-detail-back'
import { PhoneMemoryAttribution } from './PhoneMemoryAttribution'
import { humanRecurringAnswer } from '../../../src/shared/commander/recurring-answer'
import { readHandoff } from '../../../src/shared/commander/goal-handoff'
import { ResumeHandoffButton } from './ResumeHandoffButton'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type {
  CommanderAccount,
  CommanderMemoryRevision,
  CommanderMemoryWrite
} from '../../../src/shared/commander/memory-contract'
import { MobileMarkdown } from '../components/markdown/MobileMarkdown'
import { PhoneMemoryEditor } from './PhoneMemoryEditor'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { usePhoneMemoryCollection } from './use-phone-memory-collection'
import { PhoneHandoffSearch } from './PhoneHandoffSearch'
import { PhoneMemoryList } from './PhoneMemoryList'
import { PhoneRecurringAnswerSwitch } from './PhoneRecurringAnswerSwitch'
import { PhoneRecurringAnswer } from './PhoneRecurringAnswer'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import { MemoryButton, s } from './phone-memory-controls'
import {
  applyRecentConversation,
  draftWrite,
  memoryDraft,
  newHandoffDraft,
  newRecurringDraft,
  type MemoryDraft
} from './phone-memory-draft'
import {
  phoneCommanderRecentRead,
  phonePageRead,
  phonePageWrite,
  type PhonePage
} from './phone-memory-rpc'

export function PhoneMemoryLibrary({
  client,
  hostId,
  hostHandoffs,
  handoffSearch,
  hostScoped,
  handoffs = false,
  account,
  active,
  onAccessError,
  setEditing
}: {
  client: RpcClient
  hostId: string
  hostHandoffs: boolean
  handoffSearch: boolean
  handoffs?: boolean
  hostScoped?: boolean
  account: CommanderAccount
  active: boolean
  onAccessError: () => void
  setEditing: (editing: boolean) => void
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const [includeDeleted, setIncludeDeleted] = useState(false)
  const searchable = handoffs && handoffSearch
  const [queryText, setQueryText] = useState('')
  const [detail, setDetail] = useState<PhonePage | null>(null)
  const [past, setPast] = useState<CommanderMemoryRevision | null>(null)
  const [draft, setDraft] = useState<MemoryDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const running = useRef(false)
  const latestAccessError = useRef(onAccessError)
  latestAccessError.current = onAccessError
  const backFromPage = () => {
    if (busy) {
      return
    }
    setError('')
    if (past) {
      setPast(null)
    } else {
      setDetail(null)
    }
  }
  useCommanderDetailBack(active && detail && !draft ? backFromPage : null)
  const editorOpen = !!draft
  useEffect(() => {
    setEditing(active && editorOpen)
    return () => setEditing(false)
  }, [setEditing, active, editorOpen])
  // This component is keyed to the signed-in account and discarded on revocation/disconnect.
  // Disable competing reads and writes so a slower history/list request can't replace a later choice.
  const perform = useCallback(async (work: () => Promise<void>) => {
    if (running.current) {
      return
    }
    running.current = true
    setBusy(true)
    setError('')
    try {
      await work()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/account changed|memory access changed/i.test(message)) {
        latestAccessError.current()
      } else {
        setError(message)
        setConflict(/version conflict/i.test(message))
      }
    } finally {
      running.current = false
      setBusy(false)
    }
  }, [])
  const { collection, filter, loadList, savedPage } = usePhoneMemoryCollection({
    client,
    account,
    handoffs,
    searchable,
    includeDeleted,
    active: active && !detail && !draft,
    perform
  })
  const labels = {
    guideline: t('commander.memoryGuideline', 'Guideline'),
    decision: t('commander.memoryDecision', 'Decision'),
    note: t('commander.memoryNote', 'Note')
  }
  function readPage(pageId: string, beforeVersion?: number) {
    void perform(async () => {
      const result = await runRpcOperation(client, phonePageRead, {
        account,
        pageId,
        beforeVersion
      })
      setDetail((previous) =>
        beforeVersion && previous?.page.pageId === pageId
          ? { ...result, history: [...previous.history, ...result.history] }
          : result
      )
      setPast(null)
    })
  }
  function resetEditor() {
    setDraft(null)
    setError('')
    setConflict(false)
    if (detail) {
      readPage(detail.page.pageId)
    }
  }
  function writePage(write: CommanderMemoryWrite) {
    void perform(async () => {
      const { page } = await runRpcOperation(client, phonePageWrite, { account, write })
      setDraft(null)
      setConflict(false)
      setPast(null)
      setDetail({
        page,
        history: [page],
        nextBeforeVersion: page.version > 1 ? page.version : null
      })
      savedPage(page)
    })
  }
  const allProjects = t('commander.memoryGlobal', 'All projects')
  const problem = error ? (
    <Text accessibilityRole="alert" selectable style={s.meta}>
      {error}
    </Text>
  ) : null
  if (draft) {
    return (
      <PhoneMemoryEditor
        capture={() =>
          void perform(async () => {
            const recent = await runRpcOperation(client, phoneCommanderRecentRead)
            if (!recent.goal.trim() && !recent.progress.trim()) {
              setError(t('commander.handoffNoRecent', 'No recent messages to add on this host.'))
              return
            }
            setDraft((current) => applyRecentConversation(current, recent))
          })
        }
        draft={draft}
        setDraft={setDraft}
        projects={collection?.projects ?? []}
        active={active}
        busy={busy}
        conflict={conflict}
        labels={labels}
        allProjects={allProjects}
        problem={problem}
        clearConflict={() => {
          setError('')
          setConflict(false)
        }}
        save={() => writePage(draftWrite(draft))}
        resetEditor={resetEditor}
      />
    )
  }
  if (detail) {
    const page = past ?? detail.page
    const rule = humanRecurringAnswer(page)
    return (
      <ScrollView contentContainerStyle={s.stack}>
        <View style={s.row}>
          <MemoryButton label={t('common.back', 'Back')} disabled={busy} onPress={backFromPage} />
          {!past && !page.deleted && !page.recurringAnswerReceipt && (
            <MemoryButton
              label={t('common.edit', 'Edit')}
              disabled={busy}
              onPress={() => {
                setError('')
                setConflict(false)
                setDraft(memoryDraft(page))
              }}
            />
          )}
          {!past && (
            <MemoryButton
              label={t('common.refresh', 'Refresh')}
              disabled={busy}
              onPress={() => readPage(page.pageId)}
            />
          )}
        </View>
        <Text style={s.meta}>
          {labels[page.kind]} · {page.projectId ?? allProjects}
        </Text>
        <Text accessibilityRole="header" selectable style={s.heading}>
          {rule ? t('commander.ruleTitle', 'Recurring answer') : page.title}
        </Text>
        <PhoneMemoryAttribution page={page} />
        {page.deleted ? (
          <Text style={s.meta}>{t('commander.memoryDeleted', 'Deleted')}</Text>
        ) : rule ? (
          <PhoneRecurringAnswer
            key={page.pageId + '-' + page.version}
            fields={rule}
            busy={busy}
            remove={
              active && !past
                ? (requestId) =>
                    writePage({
                      pageId: page.pageId,
                      expectedVersion: page.version,
                      deleted: true,
                      requestId
                    })
                : undefined
            }
          />
        ) : (
          <MobileMarkdown content={page.body} rangeSelectable />
        )}
        {!past && hostHandoffs && readHandoff(page) && active && (
          <ResumeHandoffButton
            client={client}
            account={account}
            hostId={hostId}
            hostScoped={hostScoped}
            page={page}
          />
        )}
        {problem}
        {!past && (
          <>
            <Text accessibilityRole="header" style={s.title}>
              {t('commander.memoryHistory', 'Revision history')}
            </Text>
            {detail.history.map((rev) => (
              <Pressable
                key={rev.version}
                style={s.item}
                accessibilityRole="button"
                disabled={busy}
                onPress={() => {
                  if (rev.version === detail.page.version) {
                    setPast(detail.page)
                    return
                  }
                  void perform(async () => {
                    const result = await runRpcOperation(client, phonePageRead, {
                      account,
                      pageId: page.pageId,
                      version: rev.version
                    })
                    setPast(result.selectedRevision ?? null)
                  })
                }}
              >
                <Text style={s.title}>{rev.title}</Text>
                <PhoneMemoryAttribution page={rev} />
              </Pressable>
            ))}
            {detail.nextBeforeVersion !== null && (
              <MemoryButton
                disabled={busy}
                label={t('commander.memoryMore', 'Load more')}
                onPress={() => readPage(page.pageId, detail.nextBeforeVersion ?? undefined)}
              />
            )}
          </>
        )}
      </ScrollView>
    )
  }
  function startDraft(next: MemoryDraft) {
    setError('')
    setConflict(false)
    setDraft(next)
  }
  return (
    <PhoneMemoryList
      filtered={searchable && !!(filter.q || filter.projectId)}
      search={
        searchable ? (
          <PhoneHandoffSearch
            active={active}
            busy={busy}
            projects={collection?.projects ?? []}
            allProjects={allProjects}
            projectId={filter.projectId}
            queryText={queryText}
            setQueryText={setQueryText}
            apply={(next) => active && void loadList(undefined, false, next)}
          />
        ) : null
      }
      setting={
        active && !handoffs ? (
          <PhoneRecurringAnswerSwitch
            account={account}
            client={client}
            onAccessError={onAccessError}
          />
        ) : null
      }
      collection={collection}
      handoffs={handoffs}
      busy={busy}
      includeDeleted={includeDeleted}
      problem={problem}
      allProjects={allProjects}
      labels={labels}
      newPage={() =>
        startDraft(
          handoffs ? newHandoffDraft(searchable ? filter.projectId : undefined) : memoryDraft()
        )
      }
      newRule={() =>
        startDraft(
          newRecurringDraft(collection?.projects.length === 1 ? collection.projects[0] : null)
        )
      }
      refresh={() => void loadList()}
      toggleDeleted={() => {
        const next = !includeDeleted
        setIncludeDeleted(next)
        void loadList(undefined, next)
      }}
      more={() => void loadList(collection?.next ?? undefined)}
      open={readPage}
    />
  )
}
