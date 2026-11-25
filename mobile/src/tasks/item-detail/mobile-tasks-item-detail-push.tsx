import { useEffect, useState, type ReactNode } from 'react'
import { OptionPager, useOptionPager } from '../../components/bottom-drawer/BottomDrawer'
import type { ConnectionPresentationModel } from '../screen-state/use-mobile-tasks-connection-presentation'
import type { ActionableTaskItem } from '../mobile-tasks-project-workspace-types'
import { MobileTasksItemDetailPage } from './mobile-tasks-item-detail-page'

/** Pushes the tapped item's page over the list, as the commit page pushes over its history. */
export function MobileTasksItemDetailPush({
  model,
  children
}: {
  model: ConnectionPresentationModel
  children: ReactNode
}) {
  const pager = useOptionPager<'item'>()
  const { open, close, closeThen, page } = pager
  const { actionItem, setActionItem, taskUiReady } = model
  // The page keeps drawing its item while it slides away after Back cleared the selection.
  const [shown, setShown] = useState<ActionableTaskItem | null>(null)
  // Items a sub-issue was opened from, so Back returns to the parent before the list.
  const [trail, setTrail] = useState<readonly ActionableTaskItem[]>([])
  const [returning, setReturning] = useState(false)
  // Set from Back until the page has slid away; then the selection clears.
  const [leaving, setLeaving] = useState(false)
  if (actionItem && actionItem !== shown) {
    // Another item replacing an open one is a sub-issue; the same key is just a refreshed copy.
    if (shown && page !== null && !leaving && !returning && actionItem.key !== shown.key) {
      setTrail([...trail, shown])
    }
    setReturning(false)
    setShown(actionItem)
  }
  if (!actionItem && trail.length > 0) {
    setTrail([])
  }
  const opened = taskUiReady && actionItem !== null && !leaving
  useEffect(() => {
    if (leaving) {
      return
    }
    if (opened && page === null) {
      open('item')
    } else if (!opened && page !== null) {
      close()
    }
  }, [close, leaving, open, opened, page])
  const back = () => {
    const parent = trail.at(-1)
    if (parent) {
      setTrail(trail.slice(0, -1))
      setReturning(true)
      setActionItem(parent)
      return
    }
    setLeaving(true)
    closeThen(() => {
      setLeaving(false)
      setActionItem(null)
    })
  }
  return (
    <OptionPager
      fill
      pager={pager}
      main={children}
      page={
        page !== null && shown ? (
          // Keyed so a sub-issue opened from this page starts on its own main page.
          <MobileTasksItemDetailPage key={shown.key} model={model} item={shown} onBack={back} />
        ) : null
      }
    />
  )
}
