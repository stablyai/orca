locals {
  relay_service_names = concat(
    [var.relay_cloud_run_service_name],
    [for cell in values(var.relay_cells) : cell.service_name]
  )
  relay_service_log_filter = join(" OR ", [
    for name in local.relay_service_names : "resource.labels.service_name=\"${name}\""
  ])
  relay_runtime_log_filter = "((resource.type=\"cloud_run_revision\" AND (${local.relay_service_log_filter})) OR (resource.type=\"gce_instance\" AND jsonPayload.role=\"cell\")) AND jsonPayload.event=\"orca_relay_runtime_metrics\""
  relay_gce_connection_warning_thresholds = {
    for cell_id, cell in var.relay_gce_cells :
    cell_id => cell.connection_hard_cap == null ? 550 : floor(
      (cell.connection_hard_cap - 100 - cell.connection_unobserved_bound) * 0.85
    )
  }
  relay_gce_connection_warning_groups = {
    for threshold in distinct(values(local.relay_gce_connection_warning_thresholds)) :
    tostring(threshold) => sort([
      for cell_id, cell_threshold in local.relay_gce_connection_warning_thresholds :
      cell_id if cell_threshold == threshold
    ])
  }
  relay_incident_metrics = {
    assignment_5xx = {
      description = "Director assignment requests returning a server error."
      filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.relay_cloud_run_service_name}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl=~\"/v1/assign$\" AND httpRequest.status>=500"
    }
    assignment_edge_429 = {
      description = "Director assignment or resolve requests rejected before an instance was available."
      filter      = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.relay_cloud_run_service_name}\" AND httpRequest.requestMethod=\"POST\" AND httpRequest.requestUrl=~\"/v1/(assign|resolve)$\" AND httpRequest.status=429"
    }
    postgres_retries = {
      description = "Relay PostgreSQL transactions recovered after a retryable abort."
      filter      = "((resource.type=\"cloud_run_revision\" AND (${local.relay_service_log_filter})) OR resource.type=\"gce_instance\") AND jsonPayload.event=\"orca_relay_postgres_transaction_retry\""
    }
    postgres_retry_exhausted = {
      description = "Relay PostgreSQL transactions that exhausted bounded retry."
      filter      = "((resource.type=\"cloud_run_revision\" AND (${local.relay_service_log_filter})) OR resource.type=\"gce_instance\") AND jsonPayload.event=\"orca_relay_postgres_transaction_exhausted\""
    }
  }

  relay_runtime_metrics = {
    total_connections                  = { field = "totalConnections", description = "Open relay WebSocket requests per process." }
    controls                           = { field = "controls", description = "Authenticated standing desktop controls per process." }
    splices                            = { field = "splices", description = "Active phone-to-desktop ciphertext splices per process." }
    pending_splices                    = { field = "pendingSplices", description = "Phone connections waiting for their host data leg." }
    queued_bytes                       = { field = "queuedBytes", description = "Process-wide relay backpressure bytes." }
    http_latency_ms                    = { field = "httpLatencyMsMax", description = "Maximum director/administrative HTTP latency in the interval." }
    sql_latency_ms                     = { field = "sqlLatencyMsMax", description = "Maximum observed SQL operation latency in the interval." }
    control_renewal_latency_ms_p50     = { field = "controlRenewalLatencyMsP50", description = "Control renewal latency p50 in the interval." }
    control_renewal_latency_ms_p95     = { field = "controlRenewalLatencyMsP95", description = "Control renewal latency p95 in the interval." }
    control_renewal_latency_ms_max     = { field = "controlRenewalLatencyMsMax", description = "Maximum control renewal latency in the interval." }
    control_renewals                   = { field = "controlRenewalsDelta", description = "Control renewal attempts in the interval." }
    control_renewal_successes          = { field = "controlRenewalSuccessesDelta", description = "Successful control renewals in the interval." }
    control_renewal_lease_misses       = { field = "controlRenewalLeaseMissesDelta", description = "Control renewals that found their activity lease missing." }
    control_activity_recoveries        = { field = "controlActivityRecoveriesDelta", description = "Control activity leases recovered after a renewal miss." }
    control_activity_recovery_failures = { field = "controlActivityRecoveryFailuresDelta", description = "Control activity lease recovery attempts that failed." }
    heap_used_bytes                    = { field = "heapUsedBytes", description = "Node.js heap bytes used by the relay process." }
    event_loop_ms_p99                  = { field = "eventLoopDelayMsP99", description = "Node.js event-loop delay p99 in milliseconds." }
    forwarded_bytes                    = { field = "forwardedBytesDelta", description = "Ciphertext bytes admitted for forwarding." }
    auth_successes                     = { field = "authSuccessesDelta", description = "Successful outer relay authentication stages." }
    auth_failures                      = { field = "authFailuresDelta", description = "Rejected or timed-out outer relay authentication stages." }
    reconnects                         = { field = "reconnectsDelta", description = "Desktop control rebinds or generation replacements." }
    sql_queries                        = { field = "sqlQueriesDelta", description = "Completed relay SQL operations." }
    sql_failures                       = { field = "sqlFailuresDelta", description = "Failed relay SQL operations." }
    db_pool_total                      = { field = "databasePoolTotal", description = "Open PostgreSQL connections in the process pool." }
    db_pool_idle                       = { field = "databasePoolIdle", description = "Idle PostgreSQL connections in the process pool." }
    db_pool_waiting                    = { field = "databasePoolWaiting", description = "Current requests queued for a PostgreSQL connection." }
    db_waiters_max                     = { field = "databasePoolWaitersMax", description = "Maximum requests queued for a PostgreSQL connection during the interval." }
    db_oldest_wait_ms                  = { field = "databasePoolOldestWaitMs", description = "Current oldest PostgreSQL pool waiter age." }
    db_wait_ms_max                     = { field = "databasePoolWaitMsMax", description = "Maximum PostgreSQL pool wait during the interval." }
  }
  relay_custom_alerts = {
    connection_headroom = {
      pages_oncall = true
      metric       = "total_connections"
      # Live values, set by hand on 2026-08-05. The cell arm is ~85% of the 440 usable
      # connection units (600 hard cap - 100 rebind reserve - 60 unobserved bound); 800
      # exceeded the 600 cap outright and could never fire.
      threshold_run = 550
      threshold_gce = 374
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay process is above its reviewed connection warning point; stop new assignment to the cell and follow the hot-cell runbook."
    }
    queue_pressure = {
      pages_oncall  = false
      metric        = "queued_bytes"
      threshold_run = 50331648
      threshold_gce = 50331648
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Process-wide queued ciphertext exceeded 75% of the 64 MiB hard budget. Investigate slow receivers before admission starts rejecting."
    }
    auth_failures = {
      pages_oncall  = false
      metric        = "auth_failures"
      threshold_run = 20
      threshold_gce = 20
      duration      = "0s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Outer authentication failures exceeded the per-process interval threshold. Check auth/JWKS health and abuse sources without logging bearer values."
    }
    reconnects = {
      pages_oncall  = false
      metric        = "reconnects"
      threshold_run = 100
      threshold_gce = 100
      duration      = "0s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay control reconnects exceeded the per-process interval threshold. Check revision churn, GFE terminations, and reconnect jitter."
    }
    sql_failures = {
      pages_oncall = true
      # Tuned live on 2026-08-05 to stop Slack alert noise; codified here so an apply cannot revert it.
      metric        = "sql_failures"
      threshold_run = 0
      threshold_gce = 0
      duration      = "300s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay SQL operation failed. Check Cloud SQL availability, connection pressure, and transaction retry outcomes."
    }
    sql_latency = {
      pages_oncall  = false
      metric        = "sql_latency_ms"
      threshold_run = 500
      threshold_gce = 500
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay SQL operations remained above 500 ms. Inspect lock contention and Cloud SQL health before migrations or drains."
    }
    database_pool_waiters = {
      pages_oncall = true
      # Tuned live on 2026-08-05 to stop Slack alert noise; codified here so an apply cannot revert it.
      metric        = "db_waiters_max"
      threshold_run = 5
      threshold_gce = 5
      duration      = "300s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay process queued work for a PostgreSQL connection. Check public-assignment admission, pool saturation, and Cloud SQL latency before scaling."
    }
    database_pool_wait = {
      pages_oncall = true
      # Tuned live on 2026-08-05 to stop Slack alert noise; codified here so an apply cannot revert it.
      metric        = "db_wait_ms_max"
      threshold_run = 500
      threshold_gce = 500
      duration      = "300s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "A relay process waited over 500 ms for a PostgreSQL connection. Check long transactions and lock contention before migrations or drains."
    }
    http_latency = {
      pages_oncall  = false
      metric        = "http_latency_ms"
      threshold_run = 2000
      threshold_gce = 2000
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay HTTP handling remained above two seconds. Check director assignment/resolve latency and SQL contention; WebSocket lifetimes are intentionally excluded."
    }
    heap_pressure = {
      pages_oncall  = false
      metric        = "heap_used_bytes"
      threshold_run = 419430400
      threshold_gce = 419430400
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Node.js heap stayed above 400 MiB on a 512 MiB container. Drain the affected cell and investigate connection or queue retention."
    }
    event_loop_delay = {
      pages_oncall  = false
      metric        = "event_loop_ms_p99"
      threshold_run = 250
      threshold_gce = 250
      duration      = "120s"
      aligner       = "ALIGN_PERCENTILE_99"
      reducer       = "REDUCE_MAX"
      documentation = "Relay event-loop p99 delay stayed above 250 ms. Check CPU, SQL callbacks, synchronized heartbeats, and queue pressure."
    }
  }
}

resource "google_logging_metric" "relay_snapshot" {
  for_each = local.relay_runtime_metrics

  project         = var.project_id
  name            = "orca_relay_${each.key}"
  description     = each.value.description
  filter          = local.relay_runtime_log_filter
  value_extractor = "EXTRACT(jsonPayload.${each.value.field})"
  label_extractors = {
    role    = "EXTRACT(jsonPayload.role)"
    cell_id = "EXTRACT(jsonPayload.cellId)"
    region  = "EXTRACT(jsonPayload.region)"
  }

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = contains(["sql_latency_ms", "control_renewal_latency_ms_p50", "control_renewal_latency_ms_p95", "control_renewal_latency_ms_max", "http_latency_ms", "event_loop_ms_p99", "db_oldest_wait_ms", "db_wait_ms_max"], each.key) ? "ms" : each.key == "queued_bytes" || each.key == "heap_used_bytes" || each.key == "forwarded_bytes" ? "By" : "1"

    labels {
      key         = "role"
      value_type  = "STRING"
      description = "Relay process role."
    }

    labels {
      key         = "cell_id"
      value_type  = "STRING"
      description = "Durable relay cell identifier."
    }

    labels {
      key         = "region"
      value_type  = "STRING"
      description = "Coarse Relay region."
    }
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 24
      growth_factor      = 2
      scale              = 1
    }
  }
}

resource "google_logging_metric" "relay_incident" {
  for_each = local.relay_incident_metrics

  project     = var.project_id
  name        = "orca_relay_${each.key}"
  description = each.value.description
  filter      = each.value.filter

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "relay_custom" {
  for_each = local.relay_custom_alerts

  project      = var.project_id
  display_name = "Orca Relay: ${replace(each.key, "_", " ")}"
  combiner     = "OR"
  enabled      = true
  # Why: only the reviewed critical alerts page; the rest stay in the console. Applying one
  # list to every policy would have put the noisy ones back into Slack.
  notification_channels = each.value.pages_oncall ? var.relay_alert_notification_channels : []

  conditions {
    display_name = each.key

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_${each.value.metric}\""
      comparison      = "COMPARISON_GT"
      threshold_value = each.value.threshold_run
      duration        = each.value.duration

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = each.value.aligner
        cross_series_reducer = each.value.reducer
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  dynamic "conditions" {
    for_each = each.key == "connection_headroom" ? [] : [each.value]
    content {
      display_name = "${each.key} (GCE cell)"

      condition_threshold {
        filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_${conditions.value.metric}\""
        comparison      = "COMPARISON_GT"
        threshold_value = conditions.value.threshold_gce
        duration        = conditions.value.duration

        aggregations {
          alignment_period     = "300s"
          per_series_aligner   = conditions.value.aligner
          cross_series_reducer = conditions.value.reducer
          group_by_fields      = ["resource.label.\"instance_id\""]
        }

        trigger {
          count = 1
        }
      }
    }
  }

  documentation {
    content   = each.value.documentation
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

resource "google_monitoring_alert_policy" "relay_assignment_5xx" {
  project               = var.project_id
  display_name          = "Orca Relay: assignment 5xx"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "assignment 5xx"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_assignment_5xx\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A desktop could not obtain a Relay assignment. Check PostgreSQL retry/exhaustion signals and director SQL latency; do not restart GCE cells or invalidate pairings."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_gce_connection_headroom" {
  for_each = local.relay_gce_connection_warning_groups

  project               = var.project_id
  display_name          = "Orca Relay: connection headroom (GCE ${each.key})"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "connection headroom (GCE ${each.key})"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_total_connections\" AND (${join(" OR ", [for cell_id in each.value : "metric.label.\"cell_id\"=\"${cell_id}\""])})"
      comparison      = "COMPARISON_GT"
      threshold_value = tonumber(each.key)
      duration        = "120s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
        group_by_fields      = ["resource.label.\"instance_id\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Relay GCE cell is above 85% of its configured ordinary placement ceiling; stop new assignment to the cell and follow the hot-cell runbook."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_snapshot]
}

resource "google_monitoring_alert_policy" "relay_assignment_edge_429" {
  project               = var.project_id
  display_name          = "Orca Relay: assignment edge 429"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "assignment edge 429"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_assignment_edge_429\""
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      duration        = "0s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Cloud Run rejected a sustained assignment burst before an instance was available. Check public-assignment admission, director concurrency, and database latency before scaling."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_postgres_retry_exhausted" {
  project               = var.project_id
  display_name          = "Orca Relay: PostgreSQL retry exhausted"
  combiner              = "OR"
  enabled               = true
  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "PostgreSQL retry exhausted (Cloud Run)"

    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/orca_relay_postgres_retry_exhausted\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "180s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"service_name\""]
      }

      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "PostgreSQL retry exhausted (GCE cell)"

    condition_threshold {
      filter          = "resource.type=\"gce_instance\" AND metric.type=\"logging.googleapis.com/user/orca_relay_postgres_retry_exhausted\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "180s"

      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.\"instance_id\""]
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Relay database transaction remained unsuccessful after bounded whole-transaction retry. Check Cloud SQL deadlocks/locks and customer-visible request failures before changing cell admission."
    mime_type = "text/markdown"
  }

  depends_on = [google_logging_metric.relay_incident]
}

resource "google_monitoring_alert_policy" "relay_cloud_sql_backends" {
  project      = var.project_id
  display_name = "Orca Relay: Cloud SQL connection headroom"
  combiner     = "OR"
  enabled      = true

  notification_channels = var.relay_alert_notification_channels

  conditions {
    display_name = "Cloud SQL backends above 320"

    condition_threshold {
      filter          = "resource.type=\"cloudsql_database\" AND resource.label.\"database_id\"=\"${var.project_id}:${local.relay_database_instance_name}\" AND metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\""
      comparison      = "COMPARISON_GT"
      threshold_value = 320
      duration        = "300s"

      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }

      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Cloud SQL connections exceeded 80% of the 400-connection ceiling. Pause Relay pool or cell growth and inspect pool waits before the modeled 385-connection operating maximum is reached."
    mime_type = "text/markdown"
  }
}
