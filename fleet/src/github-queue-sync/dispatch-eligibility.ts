import { parseAgentTaskForm } from './issue-form-parser.ts';
import type { AgentTaskForm, FormProblem } from './issue-form-parser.ts';
import { readStatus } from './label-state-machine.ts';

/** Blueprint §4.1: Fleet chỉ bốc size:S. `size:small` là tên nhãn hiện có trên hungdaitool. */
export const DISPATCHABLE_SIZE_LABELS: readonly string[] = ['size:S', 'size:small'];
/** `antigravity`/`human` là để người làm, `unassigned` chưa giao — Fleet bỏ qua. */
export const DISPATCHABLE_AGENTS: readonly string[] = ['claude', 'codex', 'gemini', 'deepseek'];
const AGENT_LABEL_PREFIX = 'agent:';

export type EligibilityReason =
  | { readonly code: 'not-ready' }
  | { readonly code: 'not-size-s' }
  | { readonly code: 'agent-label-missing' }
  | { readonly code: 'agent-label-ambiguous'; readonly agents: readonly string[] }
  | { readonly code: 'agent-not-dispatchable'; readonly agent: string }
  | { readonly code: 'form-problem'; readonly problem: FormProblem };

export type Eligibility =
  | { readonly eligible: true; readonly agent: string; readonly form: AgentTaskForm }
  | { readonly eligible: false; readonly reasons: readonly EligibilityReason[] };

/**
 * Luật kiểm tra trước khi bốc (blueprint §4.2). Gom mọi lý do để một comment nói hết một lần,
 * không bắt người dùng sửa từng lỗi qua nhiều vòng poll.
 */
export function assessIssue(issue: { readonly labels: readonly string[]; readonly body: string }): Eligibility {
  const reasons: EligibilityReason[] = [];

  const status = readStatus(issue.labels);
  if (status.kind !== 'one' || status.status !== 'ready') {
    reasons.push({ code: 'not-ready' });
  }
  if (!issue.labels.some((label) => DISPATCHABLE_SIZE_LABELS.includes(label))) {
    reasons.push({ code: 'not-size-s' });
  }

  const agents = [
    ...new Set(issue.labels.filter((label) => label.startsWith(AGENT_LABEL_PREFIX)).map((label) => label.slice(AGENT_LABEL_PREFIX.length)))
  ];
  const [agent] = agents;
  if (agent === undefined) {
    reasons.push({ code: 'agent-label-missing' });
  } else if (agents.length > 1) {
    reasons.push({ code: 'agent-label-ambiguous', agents });
  } else if (!DISPATCHABLE_AGENTS.includes(agent)) {
    reasons.push({ code: 'agent-not-dispatchable', agent });
  }

  const parsed = parseAgentTaskForm(issue.body);
  if (!parsed.ok) {
    for (const problem of parsed.problems) {
      reasons.push({ code: 'form-problem', problem });
    }
  }

  if (reasons.length > 0 || !parsed.ok || agent === undefined) {
    return { eligible: false, reasons };
  }
  return { eligible: true, agent, form: parsed.form };
}

export const TRIAGE_COMMENT_MARKER = '<!-- orca-fleet:triage -->';

const SECTION_TITLES = { 1: 'Mục tiêu đo được', 2: 'Phạm vi file', 3: 'Definition of Done', 4: 'Ranh giới cấm' } as const;

function describeProblem(problem: FormProblem): string {
  const where = typeof problem.section === 'number' ? `mục ${problem.section} (${SECTION_TITLES[problem.section]})` : 'Nhánh gốc';
  switch (problem.code) {
    case 'missing-section':
      return `Thiếu ${where}.`;
    case 'empty-section':
      return `${where} đang để trống.`;
    case 'placeholder-only':
      return `${where} vẫn là nội dung mẫu, chưa điền thật.`;
    case 'invalid-scope':
      return `${where} không hợp lệ: tối đa 8 dòng, không dùng \`**\` ở gốc repo, không đường dẫn tuyệt đối hay \`..\`.`;
    case 'dod-has-no-command':
      return `${where} cần ít nhất một lệnh chạy được trong dấu backtick.`;
    case 'invalid-base-branch':
      return 'Nhánh gốc có ký tự không hợp lệ.';
  }
}

export function describeReason(reason: EligibilityReason): string {
  switch (reason.code) {
    case 'not-ready':
      return 'Issue không ở đúng một trạng thái `status:ready`.';
    case 'not-size-s':
      return 'Thiếu nhãn `size:S` (Fleet chỉ nhận task nhỏ; task lớn phải tách trước).';
    case 'agent-label-missing':
      return 'Thiếu nhãn `agent:*`.';
    case 'agent-label-ambiguous':
      return `Có nhiều nhãn agent (${reason.agents.join(', ')}); chỉ giữ đúng một.`;
    case 'agent-not-dispatchable':
      return `Nhãn \`agent:${reason.agent}\` không phải agent Fleet chạy được (${DISPATCHABLE_AGENTS.join(', ')}).`;
    case 'form-problem':
      return describeProblem(reason.problem);
  }
}

/** Comment khi Fleet trả issue về `status:triage`, liệt kê đủ lý do để người sửa một lần. */
export function formatTriageComment(reasons: readonly EligibilityReason[]): string {
  const lines = reasons.map((reason) => `- ${describeReason(reason)}`);
  return [
    TRIAGE_COMMENT_MARKER,
    '🤖 Fleet chưa nhận task này và đã trả về `status:triage`:',
    '',
    ...lines,
    '',
    'Sửa xong thì gắn lại `status:ready`.'
  ].join('\n');
}
