variable "project_id" {
  type        = string
  description = "GCP project that holds the key, the Worker's service account and the KEK escrow."
}

variable "environment" {
  type        = string
  description = "staging or production; only used for labels."
}

variable "location" {
  type        = string
  default     = "us"
  description = "Multi-region: Workers run at the user's edge, so no single region is closer."
}

variable "rotation_period" {
  type        = string
  default     = "7776000s" # 90 days
  description = "KMS key-version rotation. Old versions stay enabled, so blobs wrapped under them still decrypt; rotation never re-wraps SECRETS_KEK_WRAPPED."
}

variable "escrow_readers" {
  type        = list(string)
  default     = []
  description = "Members given secretAccessor on the KEK escrow secret (break-glass only). No service account belongs here."
}
