import { scanAiVaultSessions } from '../src/main/ai-vault/session-scanner'

const result = await scanAiVaultSessions({
  platform: 'darwin',
  limit: 20
})

const opencode = result.sessions.filter((s) => s.agent === 'opencode')
console.log(`Total sessions: ${result.sessions.length}`)
console.log(`OpenCode sessions: ${opencode.length}`)
console.log(`Issues: ${result.issues.length}`)
for (const issue of result.issues.slice(0, 5)) {
  console.log(`  [${issue.agent}] ${issue.path}: ${issue.message}`)
}
console.log('\nTop 10 OpenCode sessions:')
for (const s of opencode.slice(0, 10)) {
  console.log(
    `  ${s.sessionId} | ${s.title} | cwd=${s.cwd} | tokens=${s.totalTokens} | msgs=${s.messageCount}`
  )
  console.log(`    resume: ${s.resumeCommand}`)
  if (s.previewMessages.length > 0) {
    console.log(
      `    preview[0]: ${s.previewMessages[0].role}: ${s.previewMessages[0].text?.slice(0, 80)}`
    )
  }
}
