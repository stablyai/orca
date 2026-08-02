// Korean phrase fixes from high-visibility UI audit round 5.
export const KO_PHRASE_FIXES_ROUND5 = [
  { pattern: /검토 필요/g, replacement: '리뷰 필요', whenEnIncludes: 'Needs review' },
  { pattern: /검토 중/g, replacement: '리뷰 중', whenEnIncludes: 'In review' },
  {
    pattern: /마크다운 검토 노트/g,
    replacement: '마크다운 리뷰 노트',
    whenEnIncludes: 'Markdown Review Notes'
  },
  { pattern: /충돌 검토/g, replacement: '충돌 리뷰', whenEnIncludes: 'Review conflicts' },
  { pattern: /메모 검토/g, replacement: '리뷰 노트', whenEnIncludes: 'Review notes' },
  { pattern: /검토 스냅샷/g, replacement: '리뷰 스냅샷', whenEnIncludes: 'review snapshot' },
  { pattern: /검토를 위해/g, replacement: '리뷰를 위해', whenEnIncludes: 'for review' },
  { pattern: /검토 작업/g, replacement: '리뷰 작업', whenEnIncludes: 'review task' },
  { pattern: /지휘자 검토/g, replacement: 'Conductor 리뷰', whenEnIncludes: 'Conductor Review' },
  { pattern: /다시 검토/g, replacement: '재리뷰', whenEnIncludes: 'Re-review' },
  { pattern: /검토하고/g, replacement: '리뷰하고', whenEnIncludes: 'Review and' },
  { pattern: /검토합니다/g, replacement: '리뷰합니다', whenEnIncludes: 'Review the' },
  { pattern: /검토하세요/g, replacement: '리뷰하세요', whenEnIncludes: 'Review recent' },
  { pattern: /반복 검토/g, replacement: '반복 리뷰', whenEnIncludes: 'Recurring review' },
  {
    pattern: /출시 준비 검토/g,
    replacement: '출시 준비 리뷰',
    whenEnIncludes: 'Release readiness review'
  },
  {
    pattern: /일일 변화 검토/g,
    replacement: '일일 변경 리뷰',
    whenEnIncludes: 'Daily change review'
  },
  { pattern: /점검과 검토/g, replacement: '체크 및 리뷰', whenEnIncludes: 'checks and review' },
  { pattern: /별도로 검토/g, replacement: '별도로 리뷰', whenEnIncludes: 'reviewed separately' },
  {
    pattern: /변경 사항을 검토/g,
    replacement: '변경 사항을 리뷰',
    whenEnIncludes: 'review changes'
  },
  { pattern: /소스\/인증 검토/g, replacement: 'src/auth 리뷰', whenEnIncludes: 'review src/auth' },
  {
    pattern: /인증 예외 사례 검토/g,
    replacement: '인증 예외 사례 리뷰',
    whenEnIncludes: 'review auth edge cases'
  },
  {
    pattern: /실행 가능한 문제만/g,
    replacement: '실행 가능한 이슈만',
    whenEnIncludes: 'actionable issues'
  },
  { pattern: /설정 > 통합/g, replacement: '설정 > 연동', whenEnIncludes: 'Integrations' },
  { pattern: /Orca 기술/g, replacement: 'Orca 스킬', whenEnIncludes: 'Orca skill' },
  { pattern: /확인하다 #/g, replacement: '체크 #', whenEnIncludes: 'check #' },
  { pattern: /제출하다\./g, replacement: '제출.', whenEnIncludes: 'to submit.' },
  { pattern: /추적하다/g, replacement: '추적', whenEnIncludes: 'trace' },
  { pattern: /시작하다:/g, replacement: '실행:', whenEnIncludes: 'Launch:' },
  { pattern: /시작하다/g, replacement: '실행', whenEnIncludes: 'Launch' },
  { pattern: /표시하다/g, replacement: '표시', whenEnIncludes: 'display' },
  { pattern: /구성하다/g, replacement: '작성', whenEnIncludes: 'compose' },
  { pattern: /유지하다/g, replacement: '유지', whenEnIncludes: 'Keep' },
  { pattern: /확인하다/g, replacement: '검증', whenEnIncludes: 'verify' }
]
