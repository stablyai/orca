WITH
  supporting_versions AS (
    SELECT DISTINCT toString(properties.app_version) AS v
    FROM events
    WHERE event IN ('first_agent_interaction', 'meaningful_activity_day')
      AND timestamp >= toDateTime('2026-11-08 00:00:00')
      AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
  ),
  anchors AS (
    SELECT
      distinct_id AS uid,
      min(timestamp) AS anchor_at,
      formatDateTime(min(timestamp), '%Y-%m-%d') AS cohort_day,
      argMin(coalesce(toString(properties.platform), 'unknown'), timestamp) AS platform,
      argMin(toString(properties.app_version), timestamp) AS anchor_version
    FROM events
    WHERE event = 'onboarding_started'
      AND properties.cohort = 'fresh_install'
      AND timestamp >= toDateTime('2026-10-09 00:00:00')
      AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
    GROUP BY uid
  )
SELECT
  cohort_day,
  platform,
  count() AS fresh_anchors,
  countIf(anchor_version IN (SELECT v FROM supporting_versions)) AS on_supporting_build,
  round(100.0 * on_supporting_build / nullIf(fresh_anchors, 0), 1) AS supporting_pct
FROM anchors
WHERE anchor_at >= toDateTime('2026-11-01 00:00:00')
GROUP BY cohort_day, platform
ORDER BY cohort_day, platform
