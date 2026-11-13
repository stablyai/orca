import upstream from '../vendor/home-tab-presentation.js';
import { utf8Encode } from '../transport/crypto/Bytes';
import { uiText } from '../settings/NativeUi';
import { HomeAutomation } from './HomeAccountUsage';

const model: ESObject = upstream;
model.installUtf8Encoder(utf8Encode);

export function homeUsageResetCountdown(resetAt: number, now: number): string {
  return model.formatResetCountdown(resetAt - now) as string;
}

function scheduleLabel(expression: string, locale: string): string {
  if (!expression) { return ''; }
  let schedule: ESObject = model.describeAutomationSchedule(expression);
  switch (schedule.kind) {
    case 'invalid': return uiText('无效的计划', locale);
    case 'custom': return schedule.expression ?? uiText('自定义计划', locale);
    case 'hourly': return uiText('每小时的 {{minute}} 分', locale).replace('{{minute}}', String(schedule.minute).padStart(2, '0'));
  }
  let time = new Date(2024, 0, 1, schedule.hour, schedule.minute)
    .toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
  if (schedule.kind === 'daily') { return uiText('每天 {{time}}', locale).replace('{{time}}', time); }
  if (schedule.kind === 'weekdays') { return uiText('工作日 {{time}}', locale).replace('{{time}}', time); }
  let day = new Date(Date.UTC(2024, 0, 7 + Number(schedule.dayOfWeek))).toLocaleDateString(locale, { weekday: 'long', timeZone: 'UTC' });
  return uiText('每周 {{day}} {{time}}', locale).replace('{{day}}', day).replace('{{time}}', time);
}

export function homeAutomationSchedule(row: HomeAutomation, locale: string): string {
  let schedule = scheduleLabel(row.schedule, locale);
  let agent: string = model.TUI_AGENT_DISPLAY_NAMES[row.agentId] ?? row.agentId;
  return schedule && agent ? `${schedule} · ${agent}` : schedule || agent;
}
