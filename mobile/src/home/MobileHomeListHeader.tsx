import { StyleSheet, Text } from 'react-native'
import { LargeTitle } from '../components/ui/NavBar'
import { colors, textStyles } from '../theme/mobile-theme'
import { MobileHomeAppUpdateBanner } from './MobileHomeAppUpdateBanner'

/** "3 agents working · 1 needs you", or null when nothing is running or waiting. */
export function homeActivitySummary(workingAgents: number, needsYou: number): string | null {
  const parts = [
    workingAgents > 0 ? `${workingAgents} agent${workingAgents === 1 ? '' : 's'} working` : null,
    needsYou > 0 ? `${needsYou} need${needsYou === 1 ? 's' : ''} you` : null
  ].filter((part): part is string => part !== null)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** The large title, one grey line on what the agents are doing, and the update notice. */
export function MobileHomeListHeader(props: { workingAgents: number; needsYou: number }) {
  const summary = homeActivitySummary(props.workingAgents, props.needsYou)
  return (
    <>
      <LargeTitle
        title="Orca"
        subtitle={summary ? <Text style={styles.summary}>{summary}</Text> : undefined}
      />
      <MobileHomeAppUpdateBanner />
    </>
  )
}

const styles = StyleSheet.create({
  summary: { ...textStyles.callout, color: colors.textSecondary }
})
