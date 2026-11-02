import type { ReactNode } from 'react'
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { ChevronLeft, FolderOpen } from 'lucide-react-native'
import { joinCreateProjectPath } from '../../../src/shared/create-project-location'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { colors } from '../theme/mobile-theme'
import { addProjectStyles as styles } from './add-project-styles'
import type { AddProjectFlow } from './use-add-project-flow'

export type BrowseTarget = 'parent' | 'existing'

type FormProps = {
  flow: AddProjectFlow
  onBack: () => void
  onBrowse: (target: BrowseTarget) => void
}

export function CreateProjectForm({ flow, onBack, onBrowse }: FormProps) {
  const t = useMobileTranslation()
  const name = flow.name.trim()
  return (
    <FormFrame
      title={t('addProject.forms.newProject', 'New project')}
      message={
        flow.gitAvailable
          ? t('addProject.forms.gitRepoMessage', 'An empty Git repository on the host.')
          : t(
              'addProject.forms.plainFolderMessage',
              'Git was not found on the host, so this creates a plain folder.'
            )
      }
      onBack={onBack}
      flow={flow}
      submitLabel={t('addProject.forms.create', 'Create')}
      busyLabel={t('addProject.forms.creating', 'Creating…')}
      canSubmit={name.length > 0 && flow.parent.trim().length > 0}
      onSubmit={() => void flow.submitCreate()}
    >
      <Text style={styles.label}>{t('addProject.forms.name', 'Name')}</Text>
      <TextInput
        style={styles.input}
        value={flow.name}
        onChangeText={flow.setName}
        placeholder="my-project"
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        editable={!flow.busy}
        selectionColor={colors.accentBlue}
      />
      <ParentField flow={flow} onBrowse={onBrowse} />
      {name ? (
        <Text style={styles.hint} numberOfLines={2}>
          {joinCreateProjectPath(flow.parent, name)}
        </Text>
      ) : null}
    </FormFrame>
  )
}

export function CloneProjectForm({ flow, onBack, onBrowse }: FormProps) {
  const t = useMobileTranslation()
  return (
    <FormFrame
      title={t('addProject.forms.cloneRepository', 'Clone repository')}
      message={t('addProject.forms.cloneMessage', 'Clone a Git repository onto the host.')}
      onBack={onBack}
      flow={flow}
      submitLabel={t('addProject.forms.clone', 'Clone')}
      busyLabel={t('addProject.forms.cloning', 'Cloning…')}
      canSubmit={flow.url.trim().length > 0 && flow.parent.trim().length > 0}
      onSubmit={() => void flow.submitClone()}
    >
      <Text style={styles.label}>{t('addProject.forms.gitUrl', 'Git URL')}</Text>
      <TextInput
        style={styles.input}
        value={flow.url}
        onChangeText={flow.setUrl}
        placeholder="https://github.com/owner/repo.git"
        placeholderTextColor={colors.textMuted}
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        editable={!flow.busy}
        selectionColor={colors.accentBlue}
      />
      <ParentField flow={flow} onBrowse={onBrowse} />
      <Text style={styles.hint}>
        {t('addProject.forms.cloneHint', 'Cloned into a folder named after the repository.')}
      </Text>
    </FormFrame>
  )
}

export function ExistingProjectForm({ flow, onBack, onBrowse }: FormProps) {
  const t = useMobileTranslation()
  const canSubmit = flow.existingPath.trim().length > 0 && !flow.busy
  return (
    <FormFrame
      title={t('addProject.forms.addExistingFolder', 'Add existing folder')}
      message={t('addProject.forms.existingMessage', 'A folder already on the host.')}
      onBack={onBack}
    >
      <Text style={styles.label}>{t('addProject.forms.hostPath', 'Host path')}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          style={styles.input}
          value={flow.existingPath}
          onChangeText={flow.setExistingPath}
          placeholder="~/code/project"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!flow.busy}
          selectionColor={colors.accentBlue}
        />
        <BrowseButton disabled={flow.busy} onPress={() => onBrowse('existing')} />
      </View>
      {flow.error ? <Text style={styles.error}>{flow.error}</Text> : null}
      <View style={styles.actions}>
        {flow.busy ? <ActivityIndicator size="small" color={colors.textSecondary} /> : null}
        <Pressable
          style={({ pressed }) => [
            styles.cancelButton,
            pressed && styles.buttonPressed,
            !canSubmit && styles.submitButtonDisabled
          ]}
          disabled={!canSubmit}
          onPress={() => void flow.submitExisting('folder')}
        >
          <Text style={styles.cancelText}>
            {t('addProject.forms.addAsFolder', 'Add as folder')}
          </Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [
            styles.submitButton,
            pressed && styles.buttonPressed,
            !canSubmit && styles.submitButtonDisabled
          ]}
          disabled={!canSubmit}
          onPress={() => void flow.submitExisting('git')}
        >
          <Text style={styles.submitText}>
            {t('addProject.forms.addGitProject', 'Add Git project')}
          </Text>
        </Pressable>
      </View>
    </FormFrame>
  )
}

function ParentField({ flow, onBrowse }: Pick<FormProps, 'flow' | 'onBrowse'>) {
  const t = useMobileTranslation()
  return (
    <>
      <Text style={styles.label}>{t('addProject.forms.locationOnHost', 'Location on host')}</Text>
      <View style={styles.fieldRow}>
        <TextInput
          style={styles.input}
          value={flow.parent}
          onChangeText={flow.setParent}
          placeholder="~/orca/projects"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!flow.busy}
          selectionColor={colors.accentBlue}
        />
        <BrowseButton disabled={flow.busy} onPress={() => onBrowse('parent')} />
      </View>
    </>
  )
}

function BrowseButton({ disabled, onPress }: { disabled: boolean; onPress: () => void }) {
  const t = useMobileTranslation()
  return (
    <Pressable
      style={({ pressed }) => [styles.browseButton, pressed && styles.buttonPressed]}
      disabled={disabled}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={t('addProject.forms.browseHostFolders', 'Browse host folders')}
    >
      <FolderOpen size={16} color={colors.textSecondary} />
    </Pressable>
  )
}

function FormFrame(props: {
  title: string
  message: string
  onBack: () => void
  children: ReactNode
  flow?: AddProjectFlow
  submitLabel?: string
  busyLabel?: string
  canSubmit?: boolean
  onSubmit?: () => void
}) {
  const t = useMobileTranslation()
  const { flow, onSubmit } = props
  const enabled = props.canSubmit === true && !flow?.busy
  return (
    <View>
      <View style={styles.header}>
        <Pressable
          style={styles.backButton}
          onPress={props.onBack}
          disabled={flow?.busy}
          accessibilityRole="button"
          accessibilityLabel={t('addProject.forms.back', 'Back')}
        >
          <ChevronLeft size={18} color={colors.textSecondary} />
        </Pressable>
        <View>
          <Text style={styles.title}>{props.title}</Text>
          <Text style={styles.message}>{props.message}</Text>
        </View>
      </View>
      {props.children}
      {flow && onSubmit ? (
        <>
          {flow.error ? <Text style={styles.error}>{flow.error}</Text> : null}
          <View style={styles.actions}>
            <Pressable
              style={({ pressed }) => [
                styles.submitButton,
                pressed && styles.buttonPressed,
                !enabled && styles.submitButtonDisabled
              ]}
              disabled={!enabled}
              onPress={onSubmit}
            >
              {flow.busy ? <ActivityIndicator size="small" color={colors.bgBase} /> : null}
              <Text style={styles.submitText}>
                {flow.busy ? props.busyLabel : props.submitLabel}
              </Text>
            </Pressable>
          </View>
        </>
      ) : null}
    </View>
  )
}
