import { useState } from 'react'
import { ScrollView, StyleSheet, Text, View } from 'react-native'
import { colors, radii, spacing, textStyles, typography } from '../theme/mobile-theme'
import { BottomDrawer } from './BottomDrawer'
import { Button } from './ui/Button'
import { SheetHeader } from './ui/SheetHeader'

export type SetupTrustPrompt = {
  repoId: string
  repoName: string
  scriptContent: string
  contentHash: string
  previouslyApproved: boolean
}

type Props = {
  visible: boolean
  prompt: SetupTrustPrompt | null
  busy: boolean
  onRunOnce: () => void
  onAlwaysTrust: () => void
  onDontRun: () => void
  onClose: () => void
}

type TrustChoice = 'once' | 'always' | 'skip'

// The repo-owned orca.yaml setup-hook trust prompt, shown before a workspace
// create that would run an untrusted setup script. Extracted from NewWorktreeModal
// to keep that file focused; the async persist/create logic stays with the caller.
export function SetupHookTrustDrawer({
  visible,
  prompt,
  busy,
  onRunOnce,
  onAlwaysTrust,
  onDontRun,
  onClose
}: Props) {
  // Which button was pressed, so its spinner shows while the caller's create runs.
  const [choice, setChoice] = useState<TrustChoice | null>(null)
  const pending = busy ? choice : null

  function choose(next: TrustChoice, action: () => void): void {
    setChoice(next)
    action()
  }

  return (
    <BottomDrawer visible={visible && prompt != null} onClose={onClose}>
      {prompt ? (
        <View>
          <View style={styles.header}>
            <SheetHeader
              title={prompt.previouslyApproved ? 'Setup script changed' : 'Run setup script?'}
              subtitle={prompt.repoName}
            />
          </View>
          <Text style={styles.message}>
            {prompt.previouslyApproved
              ? `${prompt.repoName}'s orca.yaml has a new setup script since you last approved it. It runs before the workspace starts.`
              : `${prompt.repoName}'s orca.yaml runs this before the workspace starts. Only run it if you trust this repository.`}
          </Text>

          <ScrollView
            style={styles.code}
            contentContainerStyle={styles.codeContent}
            nestedScrollEnabled
            accessibilityLabel={prompt.previouslyApproved ? 'New setup script' : 'Setup script'}
          >
            <Text style={styles.codeText} selectable>
              {prompt.scriptContent}
            </Text>
          </ScrollView>

          <View style={styles.actions}>
            <Button
              label="Run once"
              variant="primary"
              block
              busy={pending === 'once'}
              disabled={busy && pending !== 'once'}
              onPress={() => choose('once', onRunOnce)}
            />
            <Button
              label="Always trust and run"
              block
              busy={pending === 'always'}
              disabled={busy && pending !== 'always'}
              onPress={() => choose('always', onAlwaysTrust)}
            />
            <Button
              label="Don't run"
              variant="plain"
              block
              busy={pending === 'skip'}
              disabled={busy && pending !== 'skip'}
              onPress={() => choose('skip', onDontRun)}
            />
          </View>
        </View>
      ) : null}
    </BottomDrawer>
  )
}

const styles = StyleSheet.create({
  header: { marginHorizontal: -spacing.sm, marginTop: -spacing.xs },
  message: {
    ...textStyles.callout,
    color: colors.textSecondary,
    textAlign: 'center',
    paddingHorizontal: spacing.lg,
    marginTop: spacing.xs,
    marginBottom: spacing.lg
  },
  code: {
    maxHeight: 200,
    marginHorizontal: spacing.xs,
    borderRadius: radii.field,
    backgroundColor: colors.groupFill,
    borderWidth: 1,
    borderColor: colors.separator
  },
  codeContent: { padding: spacing.md },
  codeText: {
    fontFamily: typography.monoFamily,
    fontSize: 13,
    lineHeight: 19,
    color: colors.textPrimary
  },
  actions: { gap: spacing.sm, marginTop: spacing.xl, marginHorizontal: spacing.xs }
})
