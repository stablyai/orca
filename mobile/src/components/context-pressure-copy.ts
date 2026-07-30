import type { RuntimeWorktreeAgentContextPressure } from '../../../src/shared/runtime-types'

type PressureLevel = RuntimeWorktreeAgentContextPressure['level']
type LimitSource = NonNullable<RuntimeWorktreeAgentContextPressure['limitSource']>

export type ContextPressureCopy = {
  title: string
  hint: string
  windowLabel: string
  approximate: string
  tokens: string
  used: string
  effectiveLimit: string
  levels: Record<PressureLevel, string>
  limitSources: Record<LimitSource, string>
}

const COPY: Record<string, ContextPressureCopy> = {
  en: {
    title: 'Context window',
    hint: 'Shows context window details',
    windowLabel: 'Context window',
    approximate: 'approximately',
    tokens: 'tokens',
    used: 'used',
    effectiveLimit: 'Effective limit',
    levels: { ok: 'healthy', warning: 'approaching limit', critical: 'near limit' },
    limitSources: {
      'soft-cap': 'soft cap',
      model: 'model maximum',
      provider: 'provider-reported'
    }
  },
  es: {
    title: 'Ventana de contexto',
    hint: 'Muestra los detalles de la ventana de contexto',
    windowLabel: 'Ventana de contexto',
    approximate: 'aproximadamente',
    tokens: 'tokens',
    used: 'usado',
    effectiveLimit: 'Límite efectivo',
    levels: { ok: 'saludable', warning: 'cerca del límite', critical: 'límite inminente' },
    limitSources: {
      'soft-cap': 'límite blando',
      model: 'máximo del modelo',
      provider: 'informado por el proveedor'
    }
  },
  ja: {
    title: 'コンテキストウィンドウ',
    hint: 'コンテキストウィンドウの詳細を表示します',
    windowLabel: 'コンテキストウィンドウ',
    approximate: '約',
    tokens: 'トークン',
    used: '使用済み',
    effectiveLimit: '有効上限',
    levels: { ok: '正常', warning: '上限に接近', critical: '上限間近' },
    limitSources: {
      'soft-cap': 'ソフト上限',
      model: 'モデル最大値',
      provider: 'プロバイダー報告値'
    }
  },
  ko: {
    title: '컨텍스트 창',
    hint: '컨텍스트 창 세부 정보를 표시합니다',
    windowLabel: '컨텍스트 창',
    approximate: '약',
    tokens: '토큰',
    used: '사용됨',
    effectiveLimit: '유효 한도',
    levels: { ok: '정상', warning: '한도에 근접', critical: '한도 임박' },
    limitSources: {
      'soft-cap': '소프트 한도',
      model: '모델 최대값',
      provider: '제공자 보고값'
    }
  },
  zh: {
    title: '上下文窗口',
    hint: '显示上下文窗口详情',
    windowLabel: '上下文窗口',
    approximate: '约',
    tokens: '个令牌',
    used: '已使用',
    effectiveLimit: '有效上限',
    levels: { ok: '正常', warning: '接近上限', critical: '即将达到上限' },
    limitSources: {
      'soft-cap': '软上限',
      model: '模型最大值',
      provider: '提供商报告值'
    }
  }
}

export function getContextPressureCopy(locale = Intl.DateTimeFormat().resolvedOptions().locale) {
  return COPY[locale.toLowerCase().split(/[-_]/, 1)[0] ?? 'en'] ?? COPY.en
}
