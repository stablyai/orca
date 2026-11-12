SELECT
  formatDateTime(timestamp, '%Y-%m-%d') AS day,
  uniqIf(distinct_id, event = 'meaningful_activity_day') AS meaningful_installs,
  uniqIf(distinct_id, event = 'meaningful_activity_day' AND toString(properties.install_cohort) = 'fresh') AS meaningful_fresh_installs,
  uniqIf(distinct_id, event = 'app_opened' AND toString(properties.app_version) IN (
    SELECT DISTINCT toString(properties.app_version) FROM events
    WHERE event = 'meaningful_activity_day' AND timestamp >= toDateTime('2026-11-08 00:00:00')
  )) AS launched_installs_on_supporting_builds
FROM events
WHERE event IN ('meaningful_activity_day', 'app_opened')
  AND timestamp >= toDateTime('2026-11-08 00:00:00')
  AND timestamp < toDateTime(formatDateTime(now(), '%Y-%m-%d 00:00:00'))
  AND properties.install_id IS NOT NULL AND properties.orca_channel IS NOT NULL
GROUP BY day
ORDER BY day
