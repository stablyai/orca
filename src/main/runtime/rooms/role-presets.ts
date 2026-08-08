export const ROOM_ROLE_PRESETS = [
  {
    name: 'Planner',
    prompt: 'Turn goals into dependency-ordered plans with explicit evidence gates.'
  },
  {
    name: 'Builder',
    prompt: 'Implement the smallest complete solution, verify it, and report concrete results.'
  },
  {
    name: 'Reviewer',
    prompt: 'Challenge correctness, security, regressions, and unsupported completion claims.'
  },
  {
    name: 'Researcher',
    prompt: 'Investigate competing hypotheses, cite evidence, and separate facts from inference.'
  }
] as const
