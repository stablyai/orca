import { useRef, useState } from 'react'
import { ActivityIndicator, Keyboard, Pressable } from 'react-native'
import {
  AtSign,
  Goal,
  Image,
  Package,
  Paperclip,
  PencilRuler,
  Plus,
  Terminal
} from 'lucide-react-native'
import { spacing } from '../../../../theme/mobile-theme'
import { themedStyleSheet, useThemedStyles } from '../../../../theme/themed-styles'
import { useMobileColors } from '../../../../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../../../../i18n/use-mobile-translation'
import { BottomDrawer } from '../../../../components/bottom-drawer/BottomDrawer'
import { SheetHeader } from '../../../../components/nav-bar/SheetHeader'
import { LIST_LEADING_INSET, ListGroup, ListRow } from '../../../../components/list/ListGroup'
import { MobileSwitch } from '../../../../components/controls/MobileSwitch'
import {
  COMPOSER_CONTROL_HIT_SLOP,
  composerInputStylesSheet as inputStylesSheet
} from '../../../../components/composer-input/composer-input-styles'

/** Plan mode as the + sheet's switch; absent where the chat has none. */
export type MobileNativeChatPlanSwitch = {
  on: boolean
  disabled: boolean
  set: (on: boolean) => Promise<unknown>
}

type AddSheet = {
  openFileMenu: () => void
  openSlashMenu: (kind: 'skill' | 'command') => void
  skillCount: number
}

/** The composer's + button: the add-to-message sheet in a structured chat, else the photo library. */
export function MobileNativeChatComposerAttachButton({
  onAttachImage,
  onAttachFiles,
  structured,
  isAttaching,
  disabled,
  menu,
  plan,
  onGoal
}: {
  onAttachImage: (() => void) | undefined
  onAttachFiles: (() => void) | undefined
  structured: boolean
  isAttaching: boolean
  disabled: boolean
  /** A structured chat's add-to-message sheet; without it the button opens the photo library. */
  menu?: AddSheet
  plan?: MobileNativeChatPlanSwitch
  /** Enters goal mode; absent while it is on or where the chat has none. */
  onGoal?: (() => void) | undefined
}): React.JSX.Element | null {
  const inputStyles = useThemedStyles(inputStylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const [attachOpen, setAttachOpen] = useState(false)
  // A terminal-backed chat has only photos to add, so its + opens the library at once.
  const sheet = structured ? menu : undefined
  const open = sheet ? () => setAttachOpen(true) : onAttachImage
  if (!open) {
    return null
  }
  const attachPress = () => {
    Keyboard.dismiss()
    open()
  }
  return (
    <>
      <Pressable
        accessibilityLabel={
          sheet
            ? t('chat.composer.addToMessage', 'Add to message')
            : t('chat.composer.attachImage', 'Attach image')
        }
        style={({ pressed }) => [inputStyles.controlButton, pressed && inputStyles.pressed]}
        onPress={attachPress}
        disabled={isAttaching || disabled}
        hitSlop={COMPOSER_CONTROL_HIT_SLOP}
      >
        {isAttaching ? (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        ) : (
          <Plus size={19} color={colors.textPrimary} strokeWidth={2} />
        )}
      </Pressable>
      {sheet ? (
        <AddToMessageSheet
          visible={attachOpen}
          onClose={() => setAttachOpen(false)}
          sheet={sheet}
          onPhotos={onAttachImage}
          onFiles={onAttachFiles}
          plan={plan}
          onGoal={onGoal}
        />
      ) : null}
    </>
  )
}

function AddToMessageSheet({
  visible,
  onClose,
  sheet,
  onPhotos,
  onFiles,
  plan,
  onGoal
}: {
  visible: boolean
  onClose: () => void
  sheet: AddSheet
  onPhotos: (() => void) | undefined
  onFiles: (() => void) | undefined
  plan: MobileNativeChatPlanSwitch | undefined
  onGoal: (() => void) | undefined
}): React.JSX.Element {
  const styles = useThemedStyles(stylesSheet)
  const colors = useMobileColors()
  const t = useMobileTranslation()
  const [planPending, setPlanPending] = useState<boolean | null>(null)
  // Pickers wait for the sheet to go: iOS cannot present them over its Modal.
  const afterCloseRef = useRef<(() => void) | null>(null)
  const closeThen = (action: () => void) => () => {
    afterCloseRef.current = action
    onClose()
  }
  const icon = (Icon: typeof Image) => <Icon size={16} color={colors.textSecondary} />
  const planOn = planPending ?? plan?.on === true
  const setPlan = (on: boolean) => {
    if (!plan || planPending !== null) {
      return
    }
    setPlanPending(on)
    void plan.set(on).finally(() => setPlanPending(null))
  }
  const planLabel = t('session.nativeChatAttachActions.plan', 'Plan first')
  return (
    <BottomDrawer
      visible={visible}
      onClose={onClose}
      onAfterClose={() => {
        const run = afterCloseRef.current
        afterCloseRef.current = null
        run?.()
      }}
      dragContentToDismiss
    >
      <SheetHeader title={t('chat.composer.addToMessage', 'Add to message')} onClose={onClose} />
      {onPhotos || onFiles ? (
        <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
          {onPhotos ? (
            <ListRow
              key="photos"
              title={t('session.nativeChatAttachActions.photos', 'Photos')}
              leading={icon(Image)}
              onPress={closeThen(onPhotos)}
            />
          ) : null}
          {onFiles ? (
            <ListRow
              key="files"
              title={t('session.nativeChatAttachActions.files', 'Files')}
              leading={icon(Paperclip)}
              onPress={closeThen(onFiles)}
            />
          ) : null}
        </ListGroup>
      ) : null}
      <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
        <ListRow
          key="workspaceFile"
          title={t('session.nativeChatAttachActions.workspaceFile', 'Workspace file')}
          leading={icon(AtSign)}
          navigates
          onPress={closeThen(sheet.openFileMenu)}
        />
        <ListRow
          key="skills"
          title={t('session.nativeChatAttachActions.skills', 'Skills')}
          leading={icon(Package)}
          {...(sheet.skillCount > 0 ? { value: String(sheet.skillCount) } : {})}
          navigates
          onPress={closeThen(() => sheet.openSlashMenu('skill'))}
        />
        <ListRow
          key="commands"
          title={t('session.nativeChatAttachActions.commands', 'Commands')}
          leading={icon(Terminal)}
          navigates
          onPress={closeThen(() => sheet.openSlashMenu('command'))}
        />
      </ListGroup>
      {plan || onGoal ? (
        <ListGroup separatorInset={LIST_LEADING_INSET} style={styles.group}>
          {plan ? (
            <ListRow
              key="plan"
              title={planLabel}
              leading={icon(PencilRuler)}
              accessory={
                <MobileSwitch
                  value={planOn}
                  disabled={plan.disabled || planPending !== null}
                  accessibilityLabel={planLabel}
                  onValueChange={setPlan}
                />
              }
            />
          ) : null}
          {onGoal ? (
            <ListRow
              key="goal"
              title={t('session.nativeChatAttachActions.goal', 'Set a goal')}
              leading={icon(Goal)}
              navigates
              onPress={closeThen(onGoal)}
            />
          ) : null}
        </ListGroup>
      ) : null}
    </BottomDrawer>
  )
}

const stylesSheet = themedStyleSheet(() => ({
  group: { marginTop: spacing.lg }
}))
