// The pickers and confirms an agent's automation rows and editor open. They render beside the
// drawer that holds those rows (a drawer drawn inside another lands inside its content), so the
// rows ask for one and the drawer's owner draws it.
import { useState } from 'react'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { PickerModal, type PickerOption } from '../components/sheets/PickerModal'
import { TextInputModal } from '../components/sheets/TextInputModal'

export type AutomationSheet =
  | {
      kind: 'picker'
      title: string
      options: PickerOption[]
      selected: string
      onSelect: (value: string) => void
      searchable?: boolean
    }
  | {
      kind: 'text'
      title: string
      value: string
      placeholder?: string
      onSubmit: (value: string) => void
    }
  | {
      kind: 'confirm'
      title: string
      message: string
      confirmLabel: string
      cancelLabel?: string
      destructive?: boolean
      onConfirm: () => void
    }

export type PresentAutomationSheet = (sheet: AutomationSheet) => void

type PickerSheet = Extract<AutomationSheet, { kind: 'picker' }>
type ConfirmSheet = Extract<AutomationSheet, { kind: 'confirm' }>
type TextSheet = Extract<AutomationSheet, { kind: 'text' }>

/** The sheet an owner holds for its rows: open one, and close only the one that closed. Each kind
 *  keeps its last content, so a closing sheet slides away with what it showed. */
export function useAutomationSheet() {
  const [open, setOpen] = useState<AutomationSheet | null>(null)
  const [picker, setPicker] = useState<PickerSheet | null>(null)
  const [confirm, setConfirm] = useState<ConfirmSheet | null>(null)
  const [text, setText] = useState<TextSheet | null>(null)
  const present: PresentAutomationSheet = (next) => {
    if (next.kind === 'picker') {
      setPicker(next)
    } else if (next.kind === 'text') {
      setText(next)
    } else {
      setConfirm(next)
    }
    setOpen(next)
  }
  const close = (closed: AutomationSheet | null) =>
    setOpen((current) => (current === closed ? null : current))
  const host = (
    <>
      <PickerModal
        visible={open !== null && open === picker}
        title={picker?.title ?? ''}
        options={picker?.options ?? []}
        selected={picker?.selected ?? ''}
        onSelect={(value) => picker?.onSelect(value)}
        onClose={() => close(picker)}
        searchable={picker?.searchable}
      />
      <TextInputModal
        visible={open !== null && open === text}
        title={text?.title ?? ''}
        defaultValue={text?.value ?? ''}
        placeholder={text?.placeholder}
        allowEmpty
        onSubmit={(value) => {
          text?.onSubmit(value)
          close(text)
        }}
        onCancel={() => close(text)}
      />
      <ConfirmModal
        visible={open !== null && open === confirm}
        title={confirm?.title ?? ''}
        message={confirm?.message ?? ''}
        confirmLabel={confirm?.confirmLabel ?? ''}
        cancelLabel={confirm?.cancelLabel}
        destructive={confirm?.destructive}
        onCancel={() => close(confirm)}
        onConfirm={() => confirm?.onConfirm()}
      />
    </>
  )
  return { present, host }
}
